import { memo } from 'react';
import { cn } from '@/lib/utils';
import type { Item, LocationWithCount } from '@/db/repositories';
import { useHighlightTarget } from '@/lib/highlight';
import { useItemDragSource } from '../item-drag';
import type { CardCustomField } from '../card-fields';
import { ItemActions } from './ItemActions';
import { ItemStockValue } from './ItemStockValue';
import { FavouriteStar } from './FavouriteIndicator';
import { FieldValue } from './ItemCardFields';
import { useCardClickAction } from './useCardClickAction';
import { EMPTY_CUSTOM_FIELDS, useResolvedCardFields } from './card-fields-render';
import type { TableColumn } from './item-table-columns';
import type { ItemSelection } from './inventory-ui';

/**
 * Spreadsheet / data-grid presentation of the inventory (issue #31) — the third "View" mode
 * beside the Visual cards and the dense Data rows. Where the Data row folds an item's fields
 * into one summary line, the Table view lays them out as **aligned columns under a header**, so
 * a whole page of items can be compared field-by-field at a glance.
 *
 * The middle columns are exactly the user's configured card fields (backlog E1; see the column
 * model in `item-table-columns.ts`) — so the same "Fields" picker that curates the cards curates
 * the table — with an always-present **Name** column first and a **Stock** column last (the
 * dedicated {@link ItemStockValue}, which supersedes the plain `quantity` field).
 *
 * Column widths are a shared `grid-template-columns` string applied to both the header and every
 * row; the flexible columns use `minmax(0, …fr)` so they shrink and truncate rather than forcing
 * a horizontal scrollbar, keeping the header and rows aligned without a scroll-sync.
 */

/** The sticky-styled header row of column labels. Rendered once above the virtualised body. */
export function ItemTableHeader({
  columns,
  selecting,
  gridTemplate,
}: {
  columns: readonly TableColumn[];
  selecting: boolean;
  gridTemplate: string;
}) {
  return (
    <div
      role="row"
      aria-rowindex={1}
      style={{ gridTemplateColumns: gridTemplate }}
      className="grid items-center gap-4 border-b border-border px-3 py-2 text-xs font-medium text-muted-foreground"
    >
      {selecting ? <span role="columnheader" aria-label="Select" /> : null}
      <span role="columnheader" className="truncate">
        Name
      </span>
      {columns.map((col) => (
        <span key={col.id} role="columnheader" className="truncate">
          {col.label}
        </span>
      ))}
      <span role="columnheader" className="truncate text-right">
        Stock
      </span>
      <span role="columnheader" className="text-right" aria-label="Actions" />
    </div>
  );
}

/**
 * One item as a table row (memoised like {@link ItemRow}: it renders inside the virtualised
 * list, so an unchanged row skips its subtree as the user scrolls). Keeps the same body-click
 * shortcut, drag-to-move source and highlight-flash as the card/row presentations.
 */
export const ItemTableRow = memo(function ItemTableRow({
  item,
  locations,
  locationName,
  locationColorClass,
  locationTintClass,
  selection,
  selected = false,
  gridTemplate,
  columnIds,
  ariaRowIndex,
  categoryName = null,
  customFields = EMPTY_CUSTOM_FIELDS,
  customValues,
}: {
  item: Item;
  locations: readonly LocationWithCount[];
  locationName: string;
  locationColorClass?: string;
  locationTintClass?: string;
  selection?: ItemSelection;
  selected?: boolean;
  /** Shared `grid-template-columns` string, so this row aligns with the header and its peers. */
  gridTemplate: string;
  /** The field-column ids (order minus `quantity`) — resolved to this item's values as cells. */
  columnIds: readonly string[];
  /** 1-based row index within the table (the header is row 1), for `aria-rowindex`. */
  ariaRowIndex: number;
  categoryName?: string | null;
  customFields?: ReadonlyMap<string, CardCustomField>;
  customValues?: ReadonlyMap<string, string>;
}) {
  const { ref, isHighlighted } = useHighlightTarget<HTMLDivElement>(item.id);
  const fields = useResolvedCardFields(item, {
    order: columnIds,
    locationName,
    categoryName,
    customFields,
    customValues,
  });
  const dragProps = useItemDragSource(item);
  const { actionsRef, onClick, clickable } = useCardClickAction(selection != null);
  return (
    // eslint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/interactive-supports-focus -- the body click is a pointer-only shortcut mirroring the row's own focusable, labelled action buttons (details/move/label), so keyboard/AT users already have full parity; this is a table row (role="row" in a role="table", not a grid), so making it a focusable tab stop would only add a redundant, confusing one.
    <div
      ref={ref}
      role="row"
      aria-rowindex={ariaRowIndex}
      {...dragProps}
      onClick={onClick}
      style={{ gridTemplateColumns: gridTemplate }}
      className={cn(
        'grid select-none items-center gap-4 border-b border-border/50 px-3 py-2 transition-colors hover:bg-card/60 active:cursor-grabbing',
        locationTintClass,
        clickable && 'cursor-pointer',
        !item.isActive && 'opacity-60',
        selected && 'bg-primary/5',
        isHighlighted && 'animate-highlight',
      )}
    >
      {selection ? (
        <span role="cell" className="flex items-center">
          <input
            type="checkbox"
            checked={selected}
            onChange={() => selection.onToggle(item)}
            aria-label={`Select ${item.name}`}
            data-testid="item-select"
            className="size-4 shrink-0 accent-primary"
          />
        </span>
      ) : null}

      <span role="cell" className="flex min-w-0 items-center gap-1.5 text-sm font-medium">
        {item.isFavourite ? <FavouriteStar /> : null}
        <span className="min-w-0 truncate">{item.name}</span>
      </span>

      {fields.map((field) => (
        <span key={field.id} role="cell" className="min-w-0 truncate text-xs text-muted-foreground">
          <FieldValue
            field={field}
            locationColorClass={field.id === 'location' ? locationColorClass : undefined}
          />
        </span>
      ))}

      <span role="cell" className="flex items-center justify-end gap-2">
        <ItemStockValue item={item} gaugeSize={28} />
      </span>

      <span role="cell" className="flex items-center justify-end">
        <ItemActions ref={actionsRef} item={item} locations={locations} compact />
      </span>
    </div>
  );
});
