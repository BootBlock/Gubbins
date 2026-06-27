import { useState } from 'react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/foundry';
import {
  AddIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  DeleteIcon,
  FolderIcon,
  FolderOpenIcon,
  PackageIcon,
} from '@/components/icons';
import type { LocationTreeNode, LocationWithCount } from '@/db/repositories';
import { useDeleteLocation } from '../mutations';
import { CreateLocationDialog } from './CreateLocationDialog';

/**
 * Location navigation sidebar (spec §4): the nested, self-referential hierarchy
 * with live item counts. Selecting a location filters the item list; deleting one
 * re-parents its items to Unassigned (handled by the repository). The system
 * Unassigned location is shown but cannot be deleted.
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

  return (
    <aside className="flex w-64 shrink-0 flex-col gap-2">
      <div className="flex items-center justify-between px-1">
        <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          Locations
        </h2>
        <Button variant="ghost" size="icon" className="size-7" aria-label="Add location" onClick={() => setAddOpen(true)}>
          <AddIcon />
        </Button>
      </div>

      <nav className="space-y-0.5">
        <RootRow
          label="All items"
          count={totalCount}
          active={selectedId === null}
          onClick={() => onSelect(null)}
        />
        {tree.map((node) => (
          <LocationNode key={node.id} node={node} depth={0} selectedId={selectedId} onSelect={onSelect} />
        ))}
      </nav>

      <CreateLocationDialog open={addOpen} onClose={() => setAddOpen(false)} locations={flat} />
    </aside>
  );
}

function RootRow({
  label,
  count,
  active,
  onClick,
}: {
  label: string;
  count: number;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-sm transition-colors [&_svg]:size-4',
        active ? 'bg-primary/15 font-medium text-primary' : 'text-foreground hover:bg-secondary/60',
      )}
    >
      <PackageIcon />
      <span className="flex-1 text-left">{label}</span>
      <span className="text-xs tabular-nums text-muted-foreground">{count}</span>
    </button>
  );
}

function LocationNode({
  node,
  depth,
  selectedId,
  onSelect,
}: {
  node: LocationTreeNode;
  depth: number;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
}) {
  const [expanded, setExpanded] = useState(depth < 1);
  const deleteLocation = useDeleteLocation();
  const active = selectedId === node.id;
  const hasChildren = node.children.length > 0;

  return (
    <div>
      <div
        className={cn(
          'group flex items-center gap-1 rounded-lg pr-1 transition-colors',
          active ? 'bg-primary/15' : 'hover:bg-secondary/60',
        )}
        style={{ paddingLeft: `${depth * 12}px` }}
      >
        <button
          type="button"
          aria-label={expanded ? 'Collapse' : 'Expand'}
          onClick={() => setExpanded((v) => !v)}
          className={cn(
            'grid size-6 shrink-0 place-items-center rounded text-muted-foreground [&_svg]:size-3.5',
            !hasChildren && 'invisible',
          )}
        >
          {expanded ? <ChevronDownIcon /> : <ChevronRightIcon />}
        </button>
        <button
          type="button"
          onClick={() => onSelect(node.id)}
          className={cn(
            'flex min-w-0 flex-1 items-center gap-2 py-1.5 text-sm transition-colors [&_svg]:size-4',
            active ? 'font-medium text-primary' : 'text-foreground',
          )}
        >
          {expanded && hasChildren ? <FolderOpenIcon /> : <FolderIcon />}
          <span className="truncate text-left">{node.name}</span>
          <span className="ml-auto pl-1 text-xs tabular-nums text-muted-foreground">
            {node.itemCount}
          </span>
        </button>
        {!node.isSystem ? (
          <button
            type="button"
            aria-label={`Delete ${node.name}`}
            onClick={() => deleteLocation.mutate(node.id)}
            className="grid size-6 shrink-0 place-items-center rounded text-muted-foreground opacity-0 transition-opacity hover:text-destructive group-hover:opacity-100 [&_svg]:size-3.5"
          >
            <DeleteIcon />
          </button>
        ) : null}
      </div>

      {expanded && hasChildren ? (
        <div className="mt-0.5 space-y-0.5">
          {node.children.map((child) => (
            <LocationNode
              key={child.id}
              node={child}
              depth={depth + 1}
              selectedId={selectedId}
              onSelect={onSelect}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}
