import { type ReactNode } from 'react';
import { cn } from '@/lib/utils';
import { Spinner, Tooltip, INFO_OPEN_DELAY_MS } from '@/components/foundry';
import { ChevronDownIcon, ChevronRightIcon, PreferredIcon } from '@/components/icons';
import { useT } from '@/features/i18n';
import { locationFullness, type VolumetricFullness } from '../location-fullness';
import { useLocationDragSource, useLocationRowDrop } from '../item-drag';
import { LocationInlineRename } from './LocationInlineRename';
import { LocationRowActions } from './LocationRowActions';

export interface TreeItemProps {
  readonly id: string;
  readonly level: number;
  /**
   * 1-based index among this row's siblings, and how many siblings there are (`aria-posinset` /
   * `aria-setsize`). Required because the tree is virtualised above a threshold (issue #129): with
   * only a window of rows in the DOM, these are the only way assistive tech can report "3 of 400"
   * rather than counting the handful of rendered nodes.
   */
  readonly posInSet: number;
  readonly setSize: number;
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
  /**
   * Resolved **volumetric** fullness for this location (issue #457), or null/undefined when the
   * location has no measured internal size (so no honest volume reading exists). Surfaced as a
   * slim fill bar *distinct* from the count text — the count text's own tint stays count-based, so
   * nothing ever tints a number by a fullness it doesn't describe. Resolved in the sidebar and
   * passed in (rather than re-read here) to keep this row presentational under virtualisation.
   */
  readonly volumeFullness?: VolumetricFullness | null;
  /** True ⇒ this is the default location for new items (shows a star). */
  readonly isDefault?: boolean;
  /** True ⇒ this location is archived (row dimmed). Archiving/restoring lives in the Edit dialog. */
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
  readonly onPrintLabel?: () => void;
  readonly printLabelLabel?: string;
  /**
   * Accept an inventory item dragged onto this row and move it here (spec §4 drag-to-move).
   * When set, the row becomes a drop target that highlights while an item hovers over it and
   * calls this with the dropped item's id and name (the name lets the caller name the item in
   * its move feedback). Omit for rows that can't receive items (e.g. the synthetic "All items"
   * row, or an archived location).
   */
  readonly onDropItem?: (itemId: string, itemName: string) => void;
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
  /**
   * True while an item just dropped onto this row is being moved here (spec §4 drag-to-move).
   * The move settles quickly but the sidebar counts only refresh after an invalidation
   * round-trip, so without this the drop looks like nothing happened. The row shows a spinner
   * (in place of its count) and is marked `aria-busy` for the brief in-flight window, giving
   * immediate "landing here…" feedback right where the item was dropped.
   */
  readonly receivingItem?: boolean;
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
  posInSet,
  setSize,
  selected,
  focused,
  icon,
  label,
  colorClass,
  description,
  count,
  capacity,
  volumeFullness,
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
  onPrintLabel,
  printLabelLabel,
  onDropItem,
  draggable,
  onDropLocation,
  acceptsLocation,
  nesting,
  receivingItem,
  ref,
}: TreeItemProps) {
  const t = useT();
  // The compact tree row shows a *count* (`count / capacity`), so its tint stays count-based —
  // a volumetric over/full state would tint a number it doesn't describe (issue #457 review).
  // Volume utilisation is surfaced (with a bar + caption) on the info card and edit dialog.
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
      aria-posinset={posInSet}
      aria-setsize={setSize}
      aria-selected={selected}
      aria-expanded={expanded}
      aria-label={label}
      aria-busy={nesting || receivingItem || undefined}
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
          </>
        )}
      </span>
      {/* Hover actions sit to the *left* of the item count so revealing them never shoves the
          count leftward — the count stays pinned to the row's right edge, vertically aligned with
          every other row's count (issue #478). */}
      {!editing && (onEdit || onPrintLabel) ? (
        <LocationRowActions
          onPrintLabel={onPrintLabel}
          printLabelLabel={printLabelLabel}
          onEdit={onEdit}
          editLabel={editLabel}
        />
      ) : null}
      {!editing ? (
        nesting ? (
          // The re-parent is in flight — a spinner takes the count's place so the row visibly
          // reports "moving…" until the tree reshapes (the count would be stale anyway).
          <Spinner className="size-3.5 shrink-0" label={`Moving ${label}`} />
        ) : receivingItem ? (
          // An item is landing here — a spinner takes the count's place for the brief in-flight
          // window so the drop reads as "something's happening" before the count refreshes.
          <Spinner className="size-3.5 shrink-0" label={`Moving item into ${label}`} />
        ) : (
          <>
            {/* Volume utilisation as a distinct, quiet fill bar (issue #457) — deliberately
                separate from the count text so it never re-tints a number it doesn't describe.
                Only shown when the location has a measured internal size (an honest volume
                reading exists); count-only / unmeasured rows show no bar. The visual track and
                fill are decorative (`aria-hidden`); the labelled `role="img"` wrapper carries the
                volume reading for assistive tech, so a screen-reader user gets it too. */}
            {volumeFullness ? (
              <span
                role="img"
                aria-label={t(
                  volumeFullness.over
                    ? 'inventory.locations.tree.volumeFullnessOver'
                    : 'inventory.locations.tree.volumeFullness',
                  { vars: { percent: volumeFullness.percent } },
                )}
                className="h-1.5 w-8 shrink-0 overflow-hidden rounded-full bg-secondary"
              >
                <span
                  aria-hidden
                  className={cn(
                    'block h-full rounded-full',
                    volumeFullness.over ? 'bg-destructive' : 'bg-primary',
                  )}
                  style={{ width: `${volumeFullness.percent}%` }}
                />
              </span>
            ) : null}
            <span
              className={cn(
                'shrink-0 pl-1 text-xs tabular-nums',
                fullness?.over
                  ? 'text-glyph-danger'
                  : fullness?.full
                    ? 'text-warning'
                    : 'text-muted-foreground',
              )}
            >
              {capacity != null ? `${count}/${capacity}` : count}
            </span>
          </>
        )
      ) : null}
    </div>
  );
}
