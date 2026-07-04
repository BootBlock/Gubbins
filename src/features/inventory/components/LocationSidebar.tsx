import { type ReactNode, useEffect, useMemo, useState } from 'react';

import { plural } from '@/lib/plural';
import { Button, LiveRegion, Modal, Spinner, Tooltip, useToast } from '@/components/foundry';
import { AddIcon, DeleteIcon, PackageIcon } from '@/components/icons';
import type { LocationTreeNode, LocationWithCount } from '@/db/repositories';
import { locationColorTextClass } from '../location-color';
import { locationPath } from '../labels/location-label';
import { collectDescendantIds, pruneArchivedTree } from '../location-tree';
import { ALL_ITEMS_ID, useLocationSidebar } from '../useLocationSidebar';
import { useLocationExpansionStore } from '../useLocationExpansionStore';
import { useArchiveLocation, useMoveItem, useUpdateLocation } from '../mutations';
import { LocationTreeItem } from './LocationTreeItem';
import { LocationKindIcon } from './LocationKindIcon';
import { CreateLocationDialog } from './CreateLocationDialog';
import { EditLocationDialog } from './EditLocationDialog';
import { PrintLocationLabelDialog } from './PrintLocationLabelDialog';

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
 * to select, and Delete to remove a (non-system) location. The stateful glue (focus,
 * expansion, rename, delete, keyboard handling) lives in {@link useLocationSidebar},
 * which delegates the pure navigation maths to `resolveTreeKey` (`../tree-keyboard`).
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
  const archive = useArchiveLocation();
  const moveItem = useMoveItem();
  const updateLocation = useUpdateLocation();
  const toast = useToast();
  // Announce a drag-and-drop move (WCAG 4.1.3) — the pointer-only drop has no other feedback
  // for assistive tech, and the moved item/location may leave the current view.
  const [moveAnnouncement, setMoveAnnouncement] = useState('');
  const [showArchived, setShowArchived] = useState(false);
  const archivedCount = useMemo(() => flat.filter((l) => l.archivedAt).length, [flat]);
  // Hide archived branches (and their subtrees) unless the user opts in; navigation,
  // counts and rendering all operate on the same filtered view for consistency.
  const visibleTree = useMemo(
    () => (showArchived ? tree : pruneArchivedTree(tree as LocationTreeNode[])),
    [tree, showArchived],
  );
  const visibleFlat = useMemo(
    () => (showArchived ? flat : flat.filter((l) => !l.archivedAt)),
    [flat, showArchived],
  );

  // Keep the persisted expansion overrides bounded: drop entries for locations that no
  // longer exist (deleted since a prior session) so localStorage doesn't accumulate dead
  // ids over the app's lifetime. Pruned against the *full* flat list — not the archived-
  // filtered view — so hiding archived branches never discards their remembered state.
  const pruneExpansion = useLocationExpansionStore((s) => s.prune);
  useEffect(() => {
    // Never prune against an empty list — that's the initial pre-load state (there are
    // always at least the system locations), and it would wipe every remembered entry.
    if (flat.length === 0) return;
    pruneExpansion(new Set(flat.map((l) => l.id)));
  }, [flat, pruneExpansion]);

  const {
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
  } = useLocationSidebar({ tree: visibleTree, flat: visibleFlat, selectedId, onSelect });

  // Printable location-label dialog (Phase 73) — co-located like Edit/Delete above.
  const [printLabelNode, setPrintLabelNode] = useState<LocationTreeNode | null>(null);

  // Whether the dragged location may be nested under `targetId` (spec §4 drag-to-nest, §7.5.3):
  // never under itself or one of its own descendants (that would be a cycle), and not under its
  // current parent (a no-op). Computed over the full flat list so ancestry is always complete.
  const canNest = (draggedId: string, targetId: string) => {
    if (collectDescendantIds(draggedId, flat).has(targetId)) return false;
    return flat.find((l) => l.id === draggedId)?.parentId !== targetId;
  };

  // Re-parent a dragged location under `targetId`. The repository re-validates the move and
  // cycle-checks it (§7.5.3); on success we expand the new parent so the moved child is visible
  // and announce the move for assistive tech. Unnesting stays in the Edit dialog's Parent field.
  const nestLocation = (draggedId: string, targetId: string) => {
    // Refuse a second re-parent while one is still in flight. Each nest reshapes the tree through
    // an invalidation round-trip that takes a moment; letting the user spam drops would stack
    // concurrent re-parents whose cached `flat` view is stale between them. One at a time keeps the
    // gesture predictable — the atomic DB-side guard in LocationRepository is the correctness
    // backstop; this is the UX one.
    if (updateLocation.isPending) return;
    const dragged = flat.find((l) => l.id === draggedId);
    const target = flat.find((l) => l.id === targetId);
    if (!dragged || !target) return;
    // Announce the move as it starts (not just on success): the re-parent takes a moment and the
    // dropped row also shows a spinner (see `nestingId`), so pointer and AT users both get
    // immediate feedback that something is happening.
    setMoveAnnouncement(`Moving ${dragged.name} into ${target.name}…`);
    updateLocation.mutate(
      { id: draggedId, input: { parentId: targetId } },
      {
        onSuccess: () => {
          toggle(targetId, true);
          setMoveAnnouncement(`${dragged.name} moved into ${target.name}.`);
        },
      },
    );
  };

  // The location whose drag-to-nest re-parent is currently in flight (or null). The row it
  // points at shows a spinner until the tree reshapes, so the multi-second wait isn't silent.
  const nestingId = updateLocation.isPending ? (updateLocation.variables?.id ?? null) : null;

  // Move a dragged item into `targetId`. The move itself settles fast, but the sidebar counts
  // only refresh after an invalidation round-trip — so on its own the drop looks like nothing
  // happened. Give layered, immediate feedback instead: an AT cue that the move started + a
  // spinner on the receiving row while it's in flight (see `movingItemToId`), then a toast
  // confirming the result. The toast viewport is itself `aria-live`, so it announces the result
  // for assistive tech — the live region only carries the "Moving…" start, never a second
  // "moved" message that would double-announce.
  const moveItemToLocation = (itemId: string, itemName: string, targetId: string, targetName: string) => {
    setMoveAnnouncement(`Moving ${itemName} to ${targetName}…`);
    moveItem.mutate(
      { id: itemId, locationId: targetId },
      {
        onSuccess: () => toast.show({ tone: 'success', message: `Moved ${itemName} to ${targetName}.` }),
        onError: () => toast.show({ tone: 'danger', message: `Couldn’t move ${itemName} to ${targetName}.` }),
      },
    );
  };

  // The location currently receiving a dragged item (its move in flight), or null — the row it
  // points at shows a spinner so the drop isn't silent until the counts refresh.
  const movingItemToId = moveItem.isPending ? (moveItem.variables?.locationId ?? null) : null;

  return (
    <aside className="flex w-64 shrink-0 flex-col gap-2 large-format:w-72">
      <div className="flex items-center justify-between px-1">
        <h2
          id="locations-heading"
          className="text-xs font-semibold uppercase tracking-wide text-muted-foreground"
        >
          Locations
        </h2>
        <Tooltip content="Create a new location. Locations can be nested to any depth." triggerTabIndex={-1}>
          <span>
            <Button
              variant="ghost"
              size="icon"
              className="size-7"
              aria-label="Add location"
              onClick={() => setAddOpen(true)}
            >
              <AddIcon className="text-glyph-success" />
            </Button>
          </span>
        </Tooltip>
      </div>

      {/* APG tree: a single keydown handler on the role="tree" container drives roving-tabindex navigation. */}
      <div
        role="tree"
        aria-labelledby="locations-heading"
        tabIndex={-1}
        className="space-y-0.5"
        onKeyDown={onKeyDown}
      >
        <LocationTreeItem
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
        {renderNodes(visibleTree, 1)}
      </div>

      {archivedCount > 0 ? (
        <label className="flex cursor-pointer items-center gap-2 px-1 text-xs text-muted-foreground">
          <input
            type="checkbox"
            checked={showArchived}
            onChange={(e) => setShowArchived(e.target.checked)}
            className="size-3.5 accent-primary"
          />
          Show archived ({archivedCount})
        </label>
      ) : null}

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
          onDelete={() => {
            // Deletion moved out of the cramped hover row into this considered context. Close
            // the dialog, then route through the same confirm-or-delete flow as the keyboard
            // `Delete` key (a non-empty location still prompts before re-parenting its items).
            const loc = editLocation;
            setEditLocation(null);
            requestDelete(loc.id, loc.name, loc.itemCount);
          }}
        />
      ) : null}
      {printLabelNode ? (
        <PrintLocationLabelDialog
          open
          onClose={() => setPrintLabelNode(null)}
          location={{
            id: printLabelNode.id,
            name: printLabelNode.name,
            path: locationPath(printLabelNode.id, flat),
          }}
        />
      ) : null}

      <Modal
        open={confirmDelete !== null}
        onClose={() => setConfirmDelete(null)}
        title="Delete location?"
        description={
          confirmDelete
            ? `"${confirmDelete.name}" still holds ${confirmDelete.itemCount} ${plural(confirmDelete.itemCount, 'item')}. Deleting it will move ${confirmDelete.itemCount === 1 ? 'it' : 'them'} to Unassigned.`
            : undefined
        }
      >
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={() => setConfirmDelete(null)} disabled={deleteLocation.isPending}>
            Cancel
          </Button>
          <Button
            variant="destructive"
            onClick={confirmDeleteNow}
            disabled={deleteLocation.isPending}
            data-testid="confirm-delete-location"
          >
            {deleteLocation.isPending ? <Spinner /> : <DeleteIcon />}
            Delete location
          </Button>
        </div>
      </Modal>

      {/* Announce drag-and-drop moves (pointer-only, so no other status reaches AT). */}
      <LiveRegion visuallyHidden data-testid="location-move-live-region">
        {moveAnnouncement ? <p>{moveAnnouncement}</p> : null}
      </LiveRegion>
    </aside>
  );

  function renderNodes(nodes: readonly LocationTreeNode[], level: number): ReactNode[] {
    const out: ReactNode[] = [];
    for (const node of nodes) {
      const hasChildren = node.children.length > 0;
      const isExpanded = isOpen(node.id, level);
      out.push(
        <LocationTreeItem
          key={node.id}
          id={node.id}
          ref={setRowRef(node.id)}
          level={level}
          selected={selectedId === node.id}
          focused={focusedId === node.id}
          icon={<LocationKindIcon kind={node.kind} expanded={isExpanded && hasChildren} />}
          label={node.name}
          colorClass={locationColorTextClass(node.color)}
          description={node.description}
          count={node.itemCount}
          capacity={node.capacity}
          isDefault={node.isDefault}
          archived={node.archivedAt != null}
          expanded={hasChildren ? isExpanded : undefined}
          onToggle={hasChildren ? () => toggle(node.id, !isExpanded) : undefined}
          onSelect={() => select(node.id)}
          onFocus={() => setFocusedId(node.id)}
          editing={renamingId === node.id}
          onRename={(name) => commitRename(node.id, name)}
          onRenameCancel={() => endRename(node.id)}
          onEdit={node.isSystem ? undefined : () => setEditLocation(node)}
          editLabel={`Edit ${node.name}`}
          onArchive={
            node.isSystem || node.archivedAt != null
              ? undefined
              : () => archive.mutate({ id: node.id, archived: true })
          }
          archiveLabel={`Archive ${node.name}`}
          onRestore={
            node.archivedAt != null ? () => archive.mutate({ id: node.id, archived: false }) : undefined
          }
          restoreLabel={`Restore ${node.name}`}
          onPrintLabel={() => setPrintLabelNode(node)}
          printLabelLabel={`Print label for ${node.name}`}
          onDropItem={
            node.archivedAt != null
              ? undefined
              : (itemId, itemName) => moveItemToLocation(itemId, itemName, node.id, node.name)
          }
          receivingItem={movingItemToId === node.id}
          // Drag-to-nest (spec §4): a non-system, non-archived location can be dragged onto
          // another such location to nest beneath it. System/archived rows are neither a valid
          // source nor a valid parent (mirroring the dialogs' `!isSystem` parent filter). While a
          // nest is in flight no row is draggable, so the user can't start stacking a second
          // re-parent on top of the first (see the `isPending` gate in `nestLocation`).
          draggable={!node.isSystem && node.archivedAt == null && !updateLocation.isPending}
          onDropLocation={
            node.isSystem || node.archivedAt != null
              ? undefined
              : (draggedId) => nestLocation(draggedId, node.id)
          }
          acceptsLocation={(draggedId) => canNest(draggedId, node.id)}
          nesting={nestingId === node.id}
        />,
      );
      if (hasChildren && isExpanded) out.push(...renderNodes(node.children, level + 1));
    }
    return out;
  }
}
