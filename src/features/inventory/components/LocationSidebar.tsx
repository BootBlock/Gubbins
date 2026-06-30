import { type ReactNode, useState } from 'react';
import { Button, Modal, Spinner, Tooltip } from '@/components/foundry';
import {
  AddIcon,
  DeleteIcon,
  FolderIcon,
  FolderOpenIcon,
  PackageIcon,
} from '@/components/icons';
import type { LocationTreeNode, LocationWithCount } from '@/db/repositories';
import { locationColorTextClass } from '../location-color';
import { locationPath } from '../labels/location-label';
import { ALL_ITEMS_ID, useLocationSidebar } from '../useLocationSidebar';
import { LocationTreeItem } from './LocationTreeItem';
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
  } = useLocationSidebar({ tree, flat, selectedId, onSelect });

  // Printable location-label dialog (Phase 73) — co-located like Edit/Delete above.
  const [printLabelNode, setPrintLabelNode] = useState<LocationTreeNode | null>(null);

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
            ? `"${confirmDelete.name}" still holds ${confirmDelete.itemCount} item${
                confirmDelete.itemCount === 1 ? '' : 's'
              }. Deleting it will move ${
                confirmDelete.itemCount === 1 ? 'it' : 'them'
              } to Unassigned.`
            : undefined
        }
      >
        <div className="flex justify-end gap-2">
          <Button
            variant="ghost"
            onClick={() => setConfirmDelete(null)}
            disabled={deleteLocation.isPending}
          >
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
          icon={isExpanded && hasChildren ? <FolderOpenIcon /> : <FolderIcon />}
          label={node.name}
          colorClass={locationColorTextClass(node.color)}
          description={node.description}
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
          onDelete={node.isSystem ? undefined : () => requestDelete(node.id, node.name, node.itemCount)}
          deleteLabel={`Delete ${node.name}`}
          onPrintLabel={() => setPrintLabelNode(node)}
          printLabelLabel={`Print label for ${node.name}`}
        />,
      );
      if (hasChildren && isExpanded) out.push(...renderNodes(node.children, level + 1));
    }
    return out;
  }
}
