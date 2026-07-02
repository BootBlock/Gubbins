import { useRef, useState, type KeyboardEvent } from 'react';
import type { LocationTreeNode, LocationWithCount } from '@/db/repositories';
import { useDeleteLocation, useUpdateLocation } from './mutations';
import { resolveTreeKey, type TreeRow } from './tree-keyboard';
import { defaultParentForNewLocation } from './location-tree';

/** Sentinel id for the synthetic "All items" treeitem (selects the null filter). */
export const ALL_ITEMS_ID = '__all__';

/** Append the visible rows (descendants of collapsed nodes omitted) in render order. */
function flattenVisible(
  nodes: readonly LocationTreeNode[],
  level: number,
  isOpen: (id: string, level: number) => boolean,
  out: TreeRow[],
): void {
  for (const node of nodes) {
    const hasChildren = node.children.length > 0;
    const isExpanded = isOpen(node.id, level);
    out.push({
      id: node.id,
      level,
      expandable: hasChildren,
      expanded: isExpanded,
      deletable: !node.isSystem,
    });
    if (hasChildren && isExpanded) flattenVisible(node.children, level + 1, isOpen, out);
  }
}

/**
 * The stateful controller behind {@link LocationSidebar}: expansion (with per-node
 * override), the roving-tabindex focus target, inline-rename and full-Edit affordances,
 * delete confirmation, and the APG flat-tree keyboard handling. The pure navigation
 * maths lives in {@link resolveTreeKey} (`./tree-keyboard`); this hook is the DOM glue
 * (roving tabindex, ref focus, expand/collapse state, selection, delete confirmation),
 * leaving {@link LocationSidebar} to be (mostly) declarative markup.
 */
export function useLocationSidebar({
  tree,
  flat,
  selectedId,
  onSelect,
}: {
  tree: readonly LocationTreeNode[];
  flat: readonly LocationWithCount[];
  selectedId: string | null;
  onSelect: (id: string | null) => void;
}) {
  const [addOpen, setAddOpen] = useState(false);
  // Expansion is "top-level (level 1) open by default; deeper collapsed" — including
  // freshly-created locations — with explicit user toggles recorded as overrides.
  // (This preserves the prior per-node `depth < 1` default as the tree grows.)
  // Centralised here so the keyboard maths sees the whole visible tree.
  const [overrides, setOverrides] = useState<ReadonlyMap<string, boolean>>(() => new Map());
  // The roving-tabindex target: the one treeitem that is in the tab order.
  const [focusedId, setFocusedId] = useState<string>(ALL_ITEMS_ID);
  // The location currently open in the full Edit dialog (pencil / via the dialog), and
  // the one being renamed inline (F2). They are deliberately separate affordances.
  const [editLocation, setEditLocation] = useState<LocationWithCount | null>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  // A non-empty location pending a delete confirmation. Empty locations delete
  // straight away; only a location that still holds items prompts first, since
  // deleting it silently re-parents those items to Unassigned (spec §4).
  const [confirmDelete, setConfirmDelete] = useState<{
    id: string;
    name: string;
    itemCount: number;
  } | null>(null);
  const deleteLocation = useDeleteLocation();
  const updateLocation = useUpdateLocation();
  const rowRefs = useRef(new Map<string, HTMLDivElement>());

  const isOpen = (id: string, level: number) => overrides.get(id) ?? level === 1;

  // Seed the "+" dialog's parent with the current selection so adding inside a
  // location nests under it by default (policy in `defaultParentForNewLocation`).
  const addParentId = defaultParentForNewLocation(selectedId, flat);

  const setRowRef = (id: string) => (el: HTMLDivElement | null) => {
    if (el) rowRefs.current.set(id, el);
    else rowRefs.current.delete(id);
  };

  const toggle = (id: string, open: boolean) => setOverrides((current) => new Map(current).set(id, open));

  const select = (id: string) => {
    setFocusedId(id);
    onSelect(id === ALL_ITEMS_ID ? null : id);
  };

  // End an inline rename and return focus to the row it belonged to.
  const endRename = (id: string) => {
    setRenamingId(null);
    setFocusedId(id);
    rowRefs.current.get(id)?.focus();
  };

  const commitRename = (id: string, name: string) => {
    endRename(id);
    updateLocation.mutate({ id, input: { name } });
  };

  // Focus retreats to "All items" before a deleted row leaves the tree.
  const retreatFocusToAllItems = () => {
    setFocusedId(ALL_ITEMS_ID);
    rowRefs.current.get(ALL_ITEMS_ID)?.focus();
  };

  // Either delete an empty location outright, or open the confirmation dialog when
  // it still holds items (so re-parenting them to Unassigned is never a surprise).
  const requestDelete = (id: string, name: string, itemCount: number) => {
    if (itemCount > 0) {
      setConfirmDelete({ id, name, itemCount });
      return;
    }
    retreatFocusToAllItems();
    deleteLocation.mutate(id);
  };

  const confirmDeleteNow = () => {
    if (!confirmDelete) return;
    retreatFocusToAllItems();
    deleteLocation.mutate(confirmDelete.id, {
      onSuccess: () => setConfirmDelete(null),
    });
  };

  // The flattened visible rows, in render order — fed verbatim to the keyboard maths.
  const rowMeta: TreeRow[] = [
    { id: ALL_ITEMS_ID, level: 1, expandable: false, expanded: false, deletable: false },
  ];
  flattenVisible(tree, 1, isOpen, rowMeta);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    // Resolve against the genuinely-focused treeitem rather than React state, so a
    // key press is never read against a not-yet-flushed `focusedId` update.
    const activeId =
      (event.target as HTMLElement | null)?.closest?.('[role="treeitem"]')?.getAttribute('data-tree-id') ??
      focusedId;
    const action = resolveTreeKey(rowMeta, activeId, event.key);
    if (!action) return;
    event.preventDefault();
    switch (action.kind) {
      case 'focus':
        setFocusedId(action.id);
        rowRefs.current.get(action.id)?.focus();
        break;
      case 'expand':
        toggle(action.id, true);
        break;
      case 'collapse':
        toggle(action.id, false);
        break;
      case 'select':
        select(action.id);
        break;
      case 'edit':
        // F2 begins an inline rename of the focused (mutable) row.
        setRenamingId(action.id);
        break;
      case 'delete': {
        const target = flat.find((loc) => loc.id === action.id);
        if (target) requestDelete(target.id, target.name, target.itemCount);
        break;
      }
    }
  };

  return {
    addOpen,
    setAddOpen,
    addParentId,
    editLocation,
    setEditLocation,
    confirmDelete,
    setConfirmDelete,
    confirmDeleteNow,
    deleteLocation,
    focusedId,
    setFocusedId,
    renamingId,
    isOpen,
    toggle,
    select,
    commitRename,
    endRename,
    requestDelete,
    setRowRef,
    onKeyDown,
  };
}
