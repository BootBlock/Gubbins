import { useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { cn } from '@/lib/utils';
import { Button, Tooltip } from '@/components/foundry';
import {
  AddIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  DeleteIcon,
  EditIcon,
  FolderIcon,
  FolderOpenIcon,
  PackageIcon,
} from '@/components/icons';
import type { LocationTreeNode, LocationWithCount } from '@/db/repositories';
import { useDeleteLocation, useUpdateLocation } from '../mutations';
import { resolveTreeKey, type TreeRow } from '../tree-keyboard';
import { CreateLocationDialog } from './CreateLocationDialog';
import { EditLocationDialog } from './EditLocationDialog';

/** Sentinel id for the synthetic "All items" treeitem (selects the null filter). */
const ALL_ITEMS_ID = '__all__';

/**
 * Location navigation sidebar (spec §4): the nested, self-referential hierarchy
 * with live item counts. Selecting a location filters the item list; deleting one
 * re-parents its items to Unassigned (handled by the repository). The system
 * Unassigned location is shown but cannot be deleted.
 *
 * Accessibility (spec §3 / §2.4.1 — Phase 39): rendered as a WAI-ARIA APG `tree`.
 * The whole tree is a **single tab stop** (roving `tabindex`); once focused, the
 * arrow keys navigate it — Up/Down between visible rows, Right to expand / enter a
 * child, Left to collapse / step out to the parent, Home/End to jump, Enter/Space
 * to select, and Delete to remove a (non-system) location. The pure navigation
 * maths lives in {@link resolveTreeKey} (`../tree-keyboard`).
 */
export function LocationSidebar({
  tree,
  flat,
  selectedId,
  onSelect,
  totalCount,
}: {
  tree: readonly LocationTreeNode[];
  flat: readonly LocationWithCount[];
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  totalCount: number;
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
  const deleteLocation = useDeleteLocation();
  const updateLocation = useUpdateLocation();
  const rowRefs = useRef(new Map<string, HTMLDivElement>());

  const isOpen = (id: string, level: number) => overrides.get(id) ?? level === 1;

  // When the "+" button is pressed while a real, user-created location is selected,
  // seed the new location's parent with that selection — so adding inside a location
  // nests under it by default. The synthetic "All items" (null selection) and the
  // system-locked rows ("Unassigned", "In Transit") are *not* valid parents, so a
  // new location started from any of those defaults to top level.
  const selectedLocation = selectedId ? flat.find((l) => l.id === selectedId) : undefined;
  const addParentId = selectedLocation && !selectedLocation.isSystem ? selectedLocation.id : null;

  const setRowRef = (id: string) => (el: HTMLDivElement | null) => {
    if (el) rowRefs.current.set(id, el);
    else rowRefs.current.delete(id);
  };

  const toggle = (id: string, open: boolean) =>
    setOverrides((current) => new Map(current).set(id, open));

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
      case 'delete':
        // Focus retreats to "All items" before the deleted row leaves the tree.
        setFocusedId(ALL_ITEMS_ID);
        rowRefs.current.get(ALL_ITEMS_ID)?.focus();
        deleteLocation.mutate(action.id);
        break;
    }
  };

  return (
    <aside className="flex w-64 shrink-0 flex-col gap-2">
      <div className="flex items-center justify-between px-1">
        <h2 id="locations-heading" className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          Locations
        </h2>
        <Tooltip content="Create a new location. Locations can be nested to any depth." triggerTabIndex={-1}>
          <span>
            <Button variant="ghost" size="icon" className="size-7" aria-label="Add location" onClick={() => setAddOpen(true)}>
              <AddIcon className="text-glyph-success" />
            </Button>
          </span>
        </Tooltip>
      </div>

      {/* eslint-disable-next-line jsx-a11y/no-static-element-interactions -- APG tree: a single keydown handler on the role="tree" container drives roving-tabindex navigation. */}
      <div role="tree" aria-labelledby="locations-heading" className="space-y-0.5" onKeyDown={onKeyDown}>
        <TreeItem
          id={ALL_ITEMS_ID}
          ref={setRowRef(ALL_ITEMS_ID)}
          level={1}
          selected={selectedId === null}
          focused={focusedId === ALL_ITEMS_ID}
          icon={<PackageIcon />}
          label="All items"
          count={totalCount}
          onSelect={() => select(ALL_ITEMS_ID)}
          onFocus={() => setFocusedId(ALL_ITEMS_ID)}
        />
        {renderNodes(tree, 1)}
      </div>

      {/* Mounted only while open so the parent default is re-seeded from the current
          selection on every open (the dialog captures `defaultParentId` on mount). */}
      {addOpen ? (
        <CreateLocationDialog
          open
          onClose={() => setAddOpen(false)}
          locations={flat}
          defaultParentId={addParentId}
        />
      ) : null}
      {editLocation ? (
        <EditLocationDialog
          open
          onClose={() => setEditLocation(null)}
          location={editLocation}
          locations={flat}
        />
      ) : null}
    </aside>
  );

  function renderNodes(nodes: readonly LocationTreeNode[], level: number): ReactNode[] {
    const out: ReactNode[] = [];
    for (const node of nodes) {
      const hasChildren = node.children.length > 0;
      const isExpanded = isOpen(node.id, level);
      out.push(
        <TreeItem
          key={node.id}
          id={node.id}
          ref={setRowRef(node.id)}
          level={level}
          selected={selectedId === node.id}
          focused={focusedId === node.id}
          icon={isExpanded && hasChildren ? <FolderOpenIcon /> : <FolderIcon />}
          label={node.name}
          count={node.itemCount}
          expanded={hasChildren ? isExpanded : undefined}
          onToggle={hasChildren ? () => toggle(node.id, !isExpanded) : undefined}
          onSelect={() => select(node.id)}
          onFocus={() => setFocusedId(node.id)}
          editing={renamingId === node.id}
          onRename={(name) => commitRename(node.id, name)}
          onRenameCancel={() => endRename(node.id)}
          onEdit={node.isSystem ? undefined : () => setEditLocation(node)}
          editLabel={`Edit ${node.name}`}
          onDelete={node.isSystem ? undefined : () => deleteLocation.mutate(node.id)}
          deleteLabel={`Delete ${node.name}`}
        />,
      );
      if (hasChildren && isExpanded) out.push(...renderNodes(node.children, level + 1));
    }
    return out;
  }
}

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

interface TreeItemProps {
  readonly id: string;
  readonly level: number;
  readonly selected: boolean;
  readonly focused: boolean;
  readonly icon: ReactNode;
  readonly label: string;
  readonly count: number;
  /** `undefined` when the node has no children (no `aria-expanded`). */
  readonly expanded?: boolean;
  readonly onToggle?: () => void;
  readonly onSelect: () => void;
  readonly onFocus: () => void;
  /** When true, the label is replaced by an inline rename input (F2). */
  readonly editing?: boolean;
  readonly onRename?: (name: string) => void;
  readonly onRenameCancel?: () => void;
  readonly onEdit?: () => void;
  readonly editLabel?: string;
  readonly onDelete?: () => void;
  readonly deleteLabel?: string;
  readonly ref: (el: HTMLDivElement | null) => void;
}

/**
 * One row of the location tree, rendered as a focusable `role="treeitem"`. Hierarchy
 * is conveyed by `aria-level` (a flat ARIA tree — no nested `role="group"` wrappers),
 * indentation by padding. The expand chevron and delete control are `tabindex={-1}`
 * (and mouse/keyboard-key driven) so the treeitem itself is the only tab stop.
 */
function TreeItem({
  id,
  level,
  selected,
  focused,
  icon,
  label,
  count,
  expanded,
  onToggle,
  onSelect,
  onFocus,
  editing,
  onRename,
  onRenameCancel,
  onEdit,
  editLabel,
  onDelete,
  deleteLabel,
  ref,
}: TreeItemProps) {
  return (
    <div
      ref={ref}
      role="treeitem"
      aria-level={level}
      aria-selected={selected}
      aria-expanded={expanded}
      aria-label={label}
      tabIndex={focused ? 0 : -1}
      data-tree-id={id}
      onFocus={onFocus}
      onClick={onSelect}
      className={cn(
        'group flex cursor-pointer items-center gap-1 rounded-lg pr-1 outline-none transition-colors',
        'focus-visible:ring-2 focus-visible:ring-primary/60',
        selected ? 'bg-primary/15' : 'hover:bg-secondary/60',
      )}
      style={{ paddingLeft: `${(level - 1) * 12}px` }}
    >
      <button
        type="button"
        tabIndex={-1}
        aria-hidden="true"
        onClick={
          onToggle
            ? (e) => {
                e.stopPropagation();
                onToggle();
              }
            : undefined
        }
        className={cn(
          'grid size-6 shrink-0 place-items-center rounded text-muted-foreground [&_svg]:size-3.5',
          !onToggle && 'invisible',
        )}
      >
        {expanded ? <ChevronDownIcon /> : <ChevronRightIcon />}
      </button>
      <span
        className={cn(
          'flex min-w-0 flex-1 items-center gap-2 py-1.5 text-sm [&_svg]:size-4',
          selected ? 'font-medium text-primary' : 'text-foreground',
        )}
      >
        {icon}
        {editing && onRename && onRenameCancel ? (
          <InlineRename initial={label} onCommit={onRename} onCancel={onRenameCancel} />
        ) : (
          <>
            <span className="truncate text-left">{label}</span>
            <span className="ml-auto pl-1 text-xs tabular-nums text-muted-foreground">{count}</span>
          </>
        )}
      </span>
      {!editing && (onEdit || onDelete) ? (
        // The row actions reserve *no* layout space until the row is hovered or holds
        // keyboard focus — so a long location name is never truncated by buttons that
        // aren't even visible. On reveal, the container eases its width (and fades) open
        // with the house cubic-bezier; the reduced-motion catch-all in index.css
        // neutralises this transition for users who ask for minimal motion.
        <div
          className={cn(
            'flex shrink-0 items-center overflow-hidden opacity-0 max-w-0',
            'transition-[max-width,opacity] duration-300 ease-emphasized',
            'group-hover:max-w-[3.5rem] group-hover:opacity-100',
            'group-focus-within:max-w-[3.5rem] group-focus-within:opacity-100',
          )}
        >
          {onEdit ? (
            <button
              type="button"
              tabIndex={-1}
              aria-label={editLabel}
              onClick={(e) => {
                e.stopPropagation();
                onEdit();
              }}
              className="grid size-6 shrink-0 place-items-center rounded transition-colors hover:bg-secondary [&_svg]:size-3.5"
            >
              <EditIcon className="text-glyph-edit" />
            </button>
          ) : null}
          {onDelete ? (
            <button
              type="button"
              tabIndex={-1}
              aria-label={deleteLabel}
              onClick={(e) => {
                e.stopPropagation();
                onDelete();
              }}
              className="grid size-6 shrink-0 place-items-center rounded transition-colors hover:bg-secondary [&_svg]:size-3.5"
            >
              <DeleteIcon className="text-glyph-danger" />
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/**
 * The inline rename editor (F2): an uncontrolled-feeling text field that commits on
 * Enter / blur and abandons on Escape. Its keydown is stopped from bubbling so the
 * tree container's roving-navigation handler never sees the typing, and a `done`
 * latch prevents the trailing blur from double-firing after an Enter/Escape.
 */
function InlineRename({
  initial,
  onCommit,
  onCancel,
}: {
  initial: string;
  onCommit: (name: string) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(initial);
  const done = useRef(false);

  const commit = () => {
    if (done.current) return;
    done.current = true;
    const trimmed = value.trim();
    if (trimmed.length > 0 && trimmed !== initial) onCommit(trimmed);
    else onCancel();
  };

  return (
    <input
      autoFocus
      aria-label={`Rename ${initial}`}
      value={value}
      onChange={(e) => setValue(e.target.value)}
      onClick={(e) => e.stopPropagation()}
      onBlur={commit}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === 'Enter') {
          e.preventDefault();
          commit();
        } else if (e.key === 'Escape') {
          e.preventDefault();
          done.current = true;
          onCancel();
        }
      }}
      className="min-w-0 flex-1 rounded border border-primary/40 bg-background px-1.5 py-0.5 text-sm outline-none focus-visible:ring-2 focus-visible:ring-primary/60"
    />
  );
}
