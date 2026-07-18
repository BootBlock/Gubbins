import type { ItemSortField } from '@/db/repositories';
import { builtinCardFieldLabel, parseCustomCardFieldId, type CardCustomField } from '../card-fields';

/**
 * Pure column model for the inventory Table view (issue #31) — the field→column mapping and the
 * shared `grid-template-columns`. Kept in a plain module (no React) so the `ItemTable.tsx`
 * component file only exports components (fast-refresh friendly), mirroring the sibling
 * `card-fields-render.ts` split. Exhaustively unit-testable.
 */

/** One data column in the table (an item field), between the fixed Name and Stock columns. */
export interface TableColumn {
  readonly id: string;
  readonly label: string;
}

/**
 * The field columns for the current card-field configuration (backlog E1): the visible fields
 * in order, minus `quantity` (the dedicated Stock column shows that, richer). A custom field
 * resolves its label from the live catalogue; a stale id (absent from the catalogue) is dropped,
 * mirroring how the row resolver drops it — so the header and each row stay column-for-column
 * aligned.
 */
export function tableFieldColumns(
  order: readonly string[],
  customFields: ReadonlyMap<string, CardCustomField>,
): TableColumn[] {
  const out: TableColumn[] = [];
  for (const id of order) {
    if (id === 'quantity') continue;
    const customId = parseCustomCardFieldId(id);
    if (customId !== null) {
      const field = customFields.get(customId);
      if (field) out.push({ id, label: field.name });
    } else {
      const label = builtinCardFieldLabel(id);
      if (label) out.push({ id, label });
    }
  }
  return out;
}

/**
 * Which sortable field a table column orders by, or `null` when the column can't be sorted
 * (issue #128). The data layer's allow-list is deliberately narrow — only scalar columns on
 * `items` — so most card fields have no counterpart: `location` / `category` / `tags` live in
 * joined tables, `value` and `condition` are derived, and a custom field's value is a row in the
 * field-value table rather than a column. Those columns simply render as plain, inert labels.
 *
 * The two fixed columns are handled by their own constants below rather than through this map,
 * since they aren't card fields: Name is always present, and Stock supersedes `quantity`.
 */
const COLUMN_SORT_FIELDS: Readonly<Record<string, ItemSortField>> = {
  updated: 'updatedAt',
};

export function columnSortField(id: string): ItemSortField | null {
  return COLUMN_SORT_FIELDS[id] ?? null;
}

/** The always-present Name column sorts by the item name. */
export const NAME_COLUMN_SORT_FIELD: ItemSortField = 'name';

/**
 * The always-present Stock column sorts by `quantity` — the underlying number the column's
 * gauge/stepper presents, and the same field the dropped `quantity` card field would have used.
 */
export const STOCK_COLUMN_SORT_FIELD: ItemSortField = 'quantity';

/**
 * The shared `grid-template-columns` for the header and rows: an optional select column, the
 * flexible Name column, one flexible track per field column, then the fixed Stock and Actions
 * columns. Flexible tracks are `minmax(0, …fr)` so they shrink-and-truncate (no horizontal
 * scroll), which keeps every independent grid computing identical widths — hence aligned.
 */
export function tableGridColumns(fieldCount: number, selecting: boolean): string {
  const tracks: string[] = [];
  if (selecting) tracks.push('1.5rem');
  tracks.push('minmax(0, 2.5fr)'); // Name
  for (let i = 0; i < fieldCount; i += 1) tracks.push('minmax(0, 1fr)');
  tracks.push('8.5rem'); // Stock
  tracks.push('6.5rem'); // Actions
  return tracks.join(' ');
}
