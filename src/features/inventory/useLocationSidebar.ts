import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import type { LocationTreeNode, LocationWithCount } from '@/db/repositories';
import { useDeleteLocation, useUpdateLocation } from './mutations';
import { resolveTreeKey, type TreeRow } from './tree-keyboard';
import { defaultParentForNewLocation, flattenVisibleTree } from './location-tree';
import { useLocationExpansionStore } from './useLocationExpansionStore';

/** Sentinel id for the synthetic "All items" treeitem (selects the null filter). */
export const ALL_ITEMS_ID = '__all__';

/**
 * How long a focus request waits for a not-yet-rendered row to mount before lapsing. Generous
 * enough to cover a scroll + re-render, short enough that a row which never arrives can't take
 * focus away from wherever the user has moved on to.
 */
const PENDING_FOCUS_TIMEOUT_MS = 250;

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
  forceExpandedIds,
  scrollRowIntoView,
}: {
  tree: readonly LocationTreeNode[];
  flat: readonly LocationWithCount[];
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  /**
   * Locations forced open regardless of the stored overrides — the ancestors retained by an
   * active search/tag filter, so a deep match is reachable without hand-expanding branches
   * (issue #129). Filtering never *writes* an override, so the user's own expanded/collapsed
   * shape is restored untouched when the filter clears.
   */
  forceExpandedIds?: ReadonlySet<string>;
  /**
   * Bring a row into the rendered window before it is focused. The tree is virtualised above a
   * threshold (issue #129), so a keyboard jump — End, or a long Down-arrow run — can target a row
   * with no DOM node yet; the caller scrolls its virtualiser there and the row focuses as soon as
   * its ref registers (see `setRowRef`). Omitted (or a no-op) when nothing is virtualised.
   */
  scrollRowIntoView?: (id: string) => void;
}) {
  const [addOpen, setAddOpen] = useState(false);
  // Expansion is "top-level (level 1) open by default; deeper collapsed" — including
  // freshly-created locations — with explicit user toggles recorded as overrides.
  // (This preserves the prior per-node `depth < 1` default as the tree grows.)
  // The overrides persist to localStorage (device-local) so a user's expanded/collapsed
  // shape survives reloads; the store is the single source, this hook the reader.
  const overrides = useLocationExpansionStore((s) => s.overrides);
  const setExpanded = useLocationExpansionStore((s) => s.setExpanded);
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
  // A row a keyboard jump asked for that wasn't rendered yet (virtualised tree), plus the timer
  // that disarms it if the row never turns up. See `focusRow`.
  const pendingFocusId = useRef<string | null>(null);
  const pendingFocusTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  // A filtered ancestor is forced open (see `forceExpandedIds`) ahead of any stored override,
  // so the retained path down to a match is always walkable; otherwise the baseline applies.
  const isOpen = (id: string, level: number) =>
    forceExpandedIds?.has(id) ? true : (overrides[id] ?? level === 1);

  // Seed the "+" dialog's parent with the current selection so adding inside a
  // location nests under it by default (policy in `defaultParentForNewLocation`).
  const addParentId = defaultParentForNewLocation(selectedId, flat);

  const setRowRef = (id: string) => (el: HTMLDivElement | null) => {
    if (el) {
      rowRefs.current.set(id, el);
      // The row a keyboard jump was waiting on has just mounted (see `focusRow`) — claim it.
      if (pendingFocusId.current === id) {
        pendingFocusId.current = null;
        window.clearTimeout(pendingFocusTimer.current);
        el.focus();
      }
    } else rowRefs.current.delete(id);
  };

  /**
   * Move DOM focus to a row, whether or not it is currently rendered. Below the virtualisation
   * threshold every row is in the DOM and this focuses immediately; above it, a row outside the
   * window has no node yet, so we ask the caller to scroll there and arm a pending focus that
   * `setRowRef` claims when the row mounts. The arm is short-lived: if the row never appears (it
   * was filtered away between the keypress and the commit) it lapses rather than lying in wait to
   * steal focus later.
   */
  const focusRow = (id: string) => {
    const el = rowRefs.current.get(id);
    if (el) {
      el.focus();
      return;
    }
    pendingFocusId.current = id;
    window.clearTimeout(pendingFocusTimer.current);
    pendingFocusTimer.current = window.setTimeout(() => {
      pendingFocusId.current = null;
    }, PENDING_FOCUS_TIMEOUT_MS);
    scrollRowIntoView?.(id);
  };

  useEffect(() => () => window.clearTimeout(pendingFocusTimer.current), []);

  const toggle = (id: string, open: boolean) => setExpanded(id, open);

  const select = (id: string) => {
    setFocusedId(id);
    onSelect(id === ALL_ITEMS_ID ? null : id);
  };

  // End an inline rename and return focus to the row it belonged to.
  const endRename = (id: string) => {
    setRenamingId(null);
    setFocusedId(id);
    focusRow(id);
  };

  const commitRename = (id: string, name: string) => {
    endRename(id);
    updateLocation.mutate({ id, input: { name } });
  };

  // Focus retreats to "All items" before a deleted row leaves the tree.
  const retreatFocusToAllItems = () => {
    setFocusedId(ALL_ITEMS_ID);
    focusRow(ALL_ITEMS_ID);
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

  // The flattened visible rows, in render order. Flattened **once** and handed back to the
  // sidebar (`visibleRows`) so rendering, the ARIA set positions, the virtualiser and the keyboard
  // maths below all read the same list — they cannot disagree about which rows exist or in what
  // order, and the tree is only walked once per render.
  const visibleRows = flattenVisibleTree(tree, isOpen);
  const rowMeta: TreeRow[] = [
    { id: ALL_ITEMS_ID, level: 1, expandable: false, expanded: false, deletable: false },
    ...visibleRows.map(({ node, level }) => ({
      id: node.id,
      level,
      expandable: node.children.length > 0,
      expanded: isOpen(node.id, level),
      deletable: !node.isSystem,
    })),
  ];

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
        focusRow(action.id);
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
    visibleRows,
    toggle,
    select,
    commitRename,
    endRename,
    requestDelete,
    setRowRef,
    onKeyDown,
  };
}
