import { memo } from 'react';
import { cn } from '@/lib/utils';
import { Checkbox } from '@/components/foundry';
import type { CardFieldStoredValue, Item, LocationWithCount } from '@/db/repositories';
import { useHighlightTarget } from '@/lib/highlight';
import { isUnlimited } from '../unlimited';
import { useItemDragSource } from '../item-drag';
import { DEFAULT_VISIBLE_CARD_FIELD_IDS, type CardCustomField } from '../card-fields';
import { UnlimitedBadge } from './TrackingBadge';
import { CardBadge } from './CardBadge';
import { ItemActions } from './ItemActions';
import { ItemStockValue } from './ItemStockValue';
import { useCardClickAction } from './useCardClickAction';
import { CardFieldSummary } from './ItemCardFields';
import { FavouriteStar } from './FavouriteIndicator';
import { EMPTY_CUSTOM_FIELDS, useResolvedCardFields } from './card-fields-render';
import type { ItemSelection } from './inventory-ui';
import { ItemRowCrashed, withItemCrashBoundary } from './ItemCrashBoundary';

/**
 * Data-Heavy item presentation (spec §3): a dense, tabular row optimised for
 * scanning many records at once. When `selection` is provided (the §6 batch
 * QR-label flow, Phase 49) a selection checkbox is shown.
 *
 * Wrapped in {@link memo}: this renders inside the virtualised list, so as the user
 * scrolls (or the parent re-renders for unrelated reasons) a row whose `item`,
 * `locations`, name/colour, `selection` and `selected` are all referentially unchanged
 * skips its subtree entirely. `selection` stays stable (only its `onToggle` member), and
 * `selected` is a plain boolean, so toggling one row re-renders just that row.
 */
const ItemRowBody = memo(function ItemRow({
  item,
  locations,
  locationName,
  locationColorClass,
  locationTintClass,
  selection,
  selected = false,
  fieldOrder = DEFAULT_VISIBLE_CARD_FIELD_IDS,
  categoryName = null,
  customFields = EMPTY_CUSTOM_FIELDS,
  customValues,
  tags,
}: {
  item: Item;
  locations: readonly LocationWithCount[];
  locationName: string;
  /** Tailwind text-colour class for the location's swatch tint, if any. */
  locationColorClass?: string;
  /** Edge-tint class painting the row in its location's swatch (visual-flair F10), if coloured. */
  locationTintClass?: string;
  selection?: ItemSelection;
  /** Whether this row is currently selected (only meaningful when `selection` is set). */
  selected?: boolean;
  /** Visible card-field ids in order (backlog E1); defaults to the shipped Location + Category. */
  fieldOrder?: readonly string[];
  /** This item's resolved category name, or null when it has no category. */
  categoryName?: string | null;
  /** The live custom-field catalog, keyed by field id (stable across the list). */
  customFields?: ReadonlyMap<string, CardCustomField>;
  /** This item's stored custom-field values (fieldId → raw value), if loaded. */
  customValues?: ReadonlyMap<string, CardFieldStoredValue>;
  /** This item's tag names (issue #84), if the Tags card field is shown and they've loaded. */
  tags?: readonly string[];
}) {
  const { ref, isHighlighted } = useHighlightTarget<HTMLDivElement>(item.id);
  const fields = useResolvedCardFields(item, {
    order: fieldOrder,
    locationName,
    categoryName,
    customFields,
    customValues,
    tags,
  });
  // Drag-to-move (spec §4): unified pointer drag for mouse, pen and touch. `select-none` keeps
  // a press-drag from selecting the row's text; the control-origin guard lives in the hook.
  const dragProps = useItemDragSource(item);
  // Click-to-act (spec §3): a plain click on the row body runs the user's `cardClickAction`.
  // Suppressed during batch selection, where a body click means "toggle this row".
  const { actionsRef, onClick, clickable } = useCardClickAction(selection != null);
  return (
    // eslint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-static-element-interactions -- the body click is a pointer-only shortcut that only ever mirrors one of the row's own focusable, labelled action buttons (details/move/label), so keyboard/AT users already have full parity; giving the row itself a role + tabindex would wrap those buttons in a redundant, confusing nested tab stop.
    <div
      ref={ref}
      {...dragProps}
      onClick={onClick}
      className={cn(
        // No hover grab-hand: the grabbing cursor appears only while actively pressing to drag
        // (`:active`); hover shows a pointer when the row body is click-actionable, else default.
        'flex select-none items-center gap-4 rounded-lg border border-border/60 bg-card/40 px-4 py-2.5 transition-colors hover:bg-card/80 active:cursor-grabbing',
        // Per-location accent tint (F10): a faint left-edge accent in this row's location swatch so
        // a scan down the list reads location-clustered. A painted background layer (survives the
        // hover:bg-card swap), static, and undefined for an uncoloured location.
        locationTintClass,
        clickable && 'cursor-pointer',
        !item.isActive && 'opacity-60',
        selected && 'border-primary/60 bg-primary/5',
        isHighlighted && 'animate-highlight',
      )}
    >
      {selection ? (
        <Checkbox
          checked={selected}
          onChange={() => selection.onToggle(item)}
          aria-label={`Select ${item.name}`}
          data-testid="item-select"
        />
      ) : null}

      <div className="min-w-0 flex-1">
        <p className="flex items-center gap-1.5 text-sm font-medium">
          {item.isFavourite ? <FavouriteStar /> : null}
          <span className="min-w-0 truncate">{item.name}</span>
        </p>
        {/* The user-configured fields (backlog E1) as a compact one-line summary; empties are
            dropped, so the row keeps its dense two-line height regardless of the field set. */}
        <CardFieldSummary fields={fields} locationColorClass={locationColorClass} />
      </div>

      <CardBadge item={item} className="hidden sm:inline-flex" />
      {isUnlimited(item) ? <UnlimitedBadge className="hidden sm:inline-flex" /> : null}

      <div className="flex w-40 items-center justify-end gap-2">
        <ItemStockValue item={item} />
      </div>

      <ItemActions ref={actionsRef} item={item} locations={locations} compact />
    </div>
  );
});

/** The exported row: {@link ItemRowBody} behind a per-item crash boundary (#313). */
export const ItemRow = withItemCrashBoundary(ItemRowBody, 'item row', ItemRowCrashed);
