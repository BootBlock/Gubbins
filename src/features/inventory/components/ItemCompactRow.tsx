import { memo } from 'react';
import { cn } from '@/lib/utils';
import { Checkbox } from '@/components/foundry';
import type { CardFieldStoredValue, Item, LocationWithCount } from '@/db/repositories';
import { useT } from '@/features/i18n';
import { useHighlightTarget } from '@/lib/highlight';
import { useItemDragSource } from '../item-drag';
import { DEFAULT_VISIBLE_CARD_FIELD_IDS, primaryCardField, type CardCustomField } from '../card-fields';
import { ItemActions } from './ItemActions';
import { useCardClickAction } from './useCardClickAction';
import { FieldValue } from './ItemCardFields';
import { FavouriteStar } from './FavouriteIndicator';
import { EMPTY_CUSTOM_FIELDS, useResolvedCardFields } from './card-fields-render';
import type { ItemSelection } from './inventory-ui';
import { ItemCompactRowCrashed, withItemCrashBoundary } from './ItemCrashBoundary';

/**
 * Compact presentation (issue #444): one text line per item — the name, and one field.
 *
 * The boundary against {@link ItemRow} is deliberate and is stated in `view-modes.ts`. A Data row
 * is two stacked lines inside a bordered strip, carrying every configured field, the corner badge
 * and the stock value, at 60px. This is a single line with no border and no fill at rest, at
 * roughly half that — so the difference between them is a difference in *what is drawn*, not in
 * padding. Everything a Data row shows beyond a name and one value is dropped here on purpose:
 * the mode exists to fit as many item names on screen as possible.
 *
 * The action menu stays, for the same reason it stays on the gallery tile — the pointer-only
 * body-click shortcut is only defensible while a keyboard user reaches the same actions from a
 * focusable, labelled control.
 *
 * `memo`'d like its siblings, so a row whose props are referentially unchanged skips re-rendering
 * as the virtualised list scrolls.
 */
const ItemCompactRowBody = memo(function ItemCompactRow({
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
  ariaPosInSet,
  ariaSetSize,
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
  /** Visible card-field ids in order (backlog E1); the first non-empty one is the line's value. */
  fieldOrder?: readonly string[];
  /** This item's resolved category name, or null when it has no category. */
  categoryName?: string | null;
  /** The live custom-field catalog, keyed by field id (stable across the list). */
  customFields?: ReadonlyMap<string, CardCustomField>;
  /** This item's stored custom-field values (fieldId → raw value), if loaded. */
  customValues?: ReadonlyMap<string, CardFieldStoredValue>;
  /** This item's tag names (issue #84), if the Tags card field is shown and they've loaded. */
  tags?: readonly string[];
  /** 1-based position in the whole result set, and its size — see {@link ItemRow} (issue #208). */
  ariaPosInSet?: number;
  ariaSetSize?: number;
}) {
  const t = useT();
  const { ref, isHighlighted } = useHighlightTarget<HTMLDivElement>(item.id);
  const fields = useResolvedCardFields(item, {
    order: fieldOrder,
    locationName,
    categoryName,
    customFields,
    customValues,
    tags,
  });
  const keyField = primaryCardField(fields);
  const dragProps = useItemDragSource(item);
  const { actionsRef, onClick, clickable } = useCardClickAction(selection != null);
  return (
    // eslint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-noninteractive-element-interactions -- the body click is a pointer-only shortcut that only ever mirrors one of the row's own focusable, labelled action buttons (details/move/label), so keyboard/AT users already have full parity; giving the row itself an interactive role + tabindex would wrap those buttons in a redundant, confusing nested tab stop (its `listitem` role is structural, and adds no tab stop).
    <div
      ref={ref}
      // One item of the list its container declares, carrying its absolute position so
      // virtualisation stays invisible to assistive tech.
      role="listitem"
      aria-posinset={ariaPosInSet}
      aria-setsize={ariaSetSize}
      {...dragProps}
      onClick={onClick}
      className={cn(
        // No border and no fill at rest: at this height a box per item would read as a grid of
        // rules rather than a list of names, which is the thing the mode is trying to avoid.
        // Hover supplies the row affordance instead.
        'flex select-none items-center gap-2 rounded-md px-2 transition-colors hover:bg-card/60 active:cursor-grabbing',
        locationTintClass,
        clickable && 'cursor-pointer',
        !item.isActive && 'opacity-60',
        selected && 'bg-primary/10',
        isHighlighted && 'animate-highlight',
      )}
    >
      {selection ? (
        <Checkbox
          checked={selected}
          onChange={() => selection.onToggle(item)}
          aria-label={t('inventory.select.item', { vars: { name: item.name } })}
          data-testid="item-select"
        />
      ) : null}
      {item.isFavourite ? <FavouriteStar /> : null}
      <span className="min-w-0 flex-1 truncate text-sm">{item.name}</span>
      {/* The one field, right-aligned so a scan down the list reads as two columns. Capped at a
          share of the line so a long value can never squeeze out the name it belongs to. */}
      {keyField ? (
        <span className="hidden min-w-0 max-w-[45%] shrink-0 truncate text-xs text-muted-foreground sm:flex">
          <FieldValue field={keyField} locationColorClass={locationColorClass} />
        </span>
      ) : null}
      <ItemActions ref={actionsRef} item={item} locations={locations} compact />
    </div>
  );
});

/** The exported row: {@link ItemCompactRowBody} behind a per-item crash boundary (#313). */
export const ItemCompactRow = withItemCrashBoundary(
  ItemCompactRowBody,
  'item compact row',
  ItemCompactRowCrashed,
);
