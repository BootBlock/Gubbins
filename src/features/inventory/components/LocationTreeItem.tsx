import { type ReactNode } from 'react';
import { cn } from '@/lib/utils';
import { Spinner, Tooltip, INFO_OPEN_DELAY_MS } from '@/components/foundry';
import { ChevronDownIcon, ChevronRightIcon, PreferredIcon } from '@/components/icons';
import { locationFullness } from '../location-fullness';
import { useLocationDragSource, useLocationRowDrop } from '../item-drag';
import { LocationInlineRename } from './LocationInlineRename';
import { LocationRowActions } from './LocationRowActions';

export interface TreeItemProps {
  readonly id: string;
  readonly level: number;
  readonly selected: boolean;
  readonly focused: boolean;
  readonly icon: ReactNode;
  readonly label: string;
  /** Tailwind text-colour class tinting the name (the location's swatch), if any. */
  readonly colorClass?: string;
  /** Optional free-text description, surfaced as a hover/focus tooltip on the row. */
  readonly description?: string | null;
  readonly count: number;
  /** Optional item-capacity limit; when set the count shows as `count / capacity`. */
  readonly capacity?: number | null;
  /** True ⇒ this is the default location for new items (shows a star). */
  readonly isDefault?: boolean;
  /** True ⇒ this location is archived (row dimmed; Restore replaces Archive). */
  readonly archived?: boolean;
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
  readonly onArchive?: () => void;
  readonly archiveLabel?: string;
  readonly onRestore?: () => void;
  readonly restoreLabel?: string;
  readonly onPrintLabel?: () => void;
  readonly printLabelLabel?: string;
  /**
   * Accept an inventory item dragged onto this row and move it here (spec §4 drag-to-move).
   * When set, the row becomes a drop target that highlights while an item hovers over it and
   * calls this with the dropped item's id. Omit for rows that can't receive items (e.g. the
   * synthetic "All items" row, or an archived location).
   */
  readonly onDropItem?: (itemId: string) => void;
  /**
   * True ⇒ this row is a location drag *source*: it can be dragged onto another location row to
   * nest beneath it (spec §4 drag-to-nest). Off for rows that can't be re-nested (the synthetic
   * "All items" row, the system-locked Unassigned/In Transit rows, an archived location).
   */
  readonly draggable?: boolean;
  /**
   * Accept a location dragged onto this row and nest it here. When set, the row becomes a drop
   * target for other locations; omit for rows that can't be a parent (the "All items" row, a
   * system-locked or archived location).
   */
  readonly onDropLocation?: (locationId: string) => void;
  /**
   * Veto an illegal nest before it highlights: return `false` when `draggedLocationId` may not
   * become this row's child (it is this row itself, one of this row's ancestors, or already this
   * row's parent — §7.5.3). The row then never lights up and never accepts that drop.
   */
  readonly acceptsLocation?: (draggedLocationId: string) => boolean;
  /**
   * True while this location's drag-to-nest re-parent is in flight. The re-parent reshapes the
   * whole tree through invalidation, which can take a moment; the row shows a spinner (in place
   * of its item count) and is marked `aria-busy` so the wait has visible + AT feedback rather
   * than an unexplained pause after the drop.
   */
  readonly nesting?: boolean;
  readonly ref: (el: HTMLDivElement | null) => void;
}

/**
 * One row of the location tree, rendered as a focusable `role="treeitem"`. Hierarchy
 * is conveyed by `aria-level` (a flat ARIA tree — no nested `role="group"` wrappers),
 * indentation by padding. The expand chevron and delete control are `tabindex={-1}`
 * (and mouse/keyboard-key driven) so the treeitem itself is the only tab stop.
 */
export function LocationTreeItem({
  id,
  level,
  selected,
  focused,
  icon,
  label,
  colorClass,
  description,
  count,
  capacity,
  isDefault,
  archived,
  expanded,
  onToggle,
  onSelect,
  onFocus,
  editing,
  onRename,
  onRenameCancel,
  onEdit,
  editLabel,
  onArchive,
  archiveLabel,
  onRestore,
  restoreLabel,
  onPrintLabel,
  printLabelLabel,
  onDropItem,
  draggable,
  onDropLocation,
  acceptsLocation,
  nesting,
  ref,
}: TreeItemProps) {
  const fullness = locationFullness(count, capacity);
  // True while a draggable *item* or *location* is over this (drop-enabled) row. Registering the
  // drop target and reading the highlight both flow through the pointer-drag provider; a row with
  // neither `onDropItem` nor `onDropLocation` (the "All items" row, an archived location) never
  // registers, and an illegal nest is vetoed by `acceptsLocation` so it never highlights.
  const dropActive = useLocationRowDrop(id, { onDropItem, onDropLocation, acceptsLocation });
  // Location drag *source* wiring — spread only when this row may be re-nested. The hook is
  // side-effect-free, so it is always called (Rules of Hooks) and the props conditionally spread.
  const dragSource = useLocationDragSource({ id, name: label });
  return (
    // eslint-disable-next-line jsx-a11y/click-events-have-key-events -- APG tree: the container's onKeyDown (resolveTreeKey) handles Enter/Space activation for the focused row, so this row's onClick has full keyboard parity; a row-level key handler would double-fire.
    <div
      ref={ref}
      role="treeitem"
      aria-level={level}
      aria-selected={selected}
      aria-expanded={expanded}
      aria-label={label}
      aria-busy={nesting || undefined}
      tabIndex={focused ? 0 : -1}
      data-tree-id={id}
      onFocus={onFocus}
      onClick={onSelect}
      {...(draggable ? dragSource : undefined)}
      className={cn(
        'group flex cursor-pointer items-center gap-1 rounded-lg pr-1 outline-none transition-colors',
        'focus-visible:ring-2 focus-visible:ring-primary/60',
        // A draggable row keeps the standard pointer on hover (it's selectable) and only shows the
        // grabbing cursor while actively pressed to drag (`:active`, plus the global drag-cursor
        // class once a drag arms); `select-none` stops a press-drag selecting its text.
        draggable && 'select-none active:cursor-grabbing',
        selected ? 'bg-primary/15' : 'hover:bg-secondary/60',
        (archived || nesting) && 'opacity-60',
        dropActive && 'bg-primary/20 ring-2 ring-primary ring-inset',
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
          <LocationInlineRename initial={label} onCommit={onRename} onCancel={onRenameCancel} />
        ) : (
          <>
            {description ? (
              // The description rides as a hover/focus tooltip on the name. The wrapper
              // takes the flex role so the name still truncates within the row.
              <Tooltip
                content={description}
                placement="right"
                triggerTabIndex={-1}
                openDelayMs={INFO_OPEN_DELAY_MS}
                className="min-w-0 flex-1"
              >
                <span className={cn('block truncate text-left', colorClass)}>{label}</span>
              </Tooltip>
            ) : (
              <span className={cn('min-w-0 flex-1 truncate text-left', colorClass)}>{label}</span>
            )}
            {isDefault ? (
              <PreferredIcon className="ml-1 size-3.5 shrink-0 text-warning" aria-label="Default location" />
            ) : null}
            {nesting ? (
              // The re-parent is in flight — a spinner takes the count's place so the row visibly
              // reports "moving…" until the tree reshapes (the count would be stale anyway).
              <Spinner className="ml-auto size-3.5 shrink-0" label={`Moving ${label}`} />
            ) : (
              <span
                className={cn(
                  'ml-auto pl-1 text-xs tabular-nums',
                  fullness?.over
                    ? 'text-glyph-danger'
                    : fullness?.full
                      ? 'text-warning'
                      : 'text-muted-foreground',
                )}
              >
                {capacity != null ? `${count}/${capacity}` : count}
              </span>
            )}
          </>
        )}
      </span>
      {!editing && (onEdit || onPrintLabel || onArchive || onRestore) ? (
        <LocationRowActions
          onPrintLabel={onPrintLabel}
          printLabelLabel={printLabelLabel}
          onEdit={onEdit}
          editLabel={editLabel}
          onArchive={onArchive}
          archiveLabel={archiveLabel}
          onRestore={onRestore}
          restoreLabel={restoreLabel}
        />
      ) : null}
    </div>
  );
}
