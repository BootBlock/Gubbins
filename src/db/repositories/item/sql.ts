/**
 * Reusable SQL fragments for item reads, shared across the {@link ItemRepository}
 * concern modules. Keeping them here means the correlated thumbnail subquery and the
 * capability "best match" score are defined once rather than copied per query.
 */

/**
 * A correlated subquery yielding an item's *primary* thumbnail blob (lowest
 * `position`) and nothing else from `item_images` (spec §4.2.4: list/detail reads
 * JOIN the image table but select the thumbnail only — never the full-res path).
 */
export const THUMBNAIL_SUBQUERY = `(
  SELECT thumbnail_blob FROM item_images
  WHERE item_images.item_id = items.id
  ORDER BY position ASC, rowid ASC LIMIT 1
) AS thumbnail_blob`;

/**
 * A correlated subquery yielding an item's "best match" relevance score (spec §4,
 * §5.1): the summed `weight` of the queried capabilities the item actually carries.
 * The `keyCount` placeholders are bound to the de-duplicated capability keys the AST
 * filters on (case-insensitive). An item missing every queried capability scores 0.
 */
export function capabilityMatchScore(keyCount: number): string {
  const placeholders = Array.from({ length: keyCount }, () => '?').join(', ');
  return `(
    SELECT COALESCE(SUM(c.weight), 0) FROM capabilities c
    WHERE c.item_id = items.id AND c.key COLLATE NOCASE IN (${placeholders})
  ) AS match_score`;
}

/** The scalar item fields a caller may sort a list read by (an explicit `ORDER BY`). */
export type ItemSortField =
  'name' | 'quantity' | 'unitCost' | 'mpn' | 'manufacturer' | 'createdAt' | 'updatedAt' | 'serialNo';

/** One sort term: a whitelisted field and a direction. */
export interface ItemSort {
  readonly field: ItemSortField;
  readonly direction: 'asc' | 'desc';
}

/**
 * The sortable-field allow-list: field name → real column (+ whether it collates
 * case-insensitively). Only these fixed identifiers ever reach the SQL text — the sort
 * field is **never** interpolated from free user input — so there is no injection surface.
 */
const ITEM_SORT_COLUMNS: Readonly<Record<ItemSortField, { column: string; collate: boolean }>> = {
  name: { column: 'items.name', collate: true },
  quantity: { column: 'items.quantity', collate: false },
  unitCost: { column: 'items.unit_cost', collate: false },
  mpn: { column: 'items.mpn', collate: true },
  manufacturer: { column: 'items.manufacturer', collate: true },
  createdAt: { column: 'items.created_at', collate: false },
  updatedAt: { column: 'items.updated_at', collate: false },
  serialNo: { column: 'items.serial_no', collate: false },
};

/** The sortable field names, for validating a caller's requested sort before it reaches SQL. */
export const ITEM_SORT_FIELDS: readonly ItemSortField[] = Object.keys(ITEM_SORT_COLUMNS) as ItemSortField[];

/**
 * Build the column list for an explicit `ORDER BY` from a validated sort spec, or `null` when
 * there is nothing to sort by (so callers keep their default ordering). NULLs are forced last
 * regardless of direction (SQLite puts them first on `DESC`), and a stable `items.id` tiebreak
 * is always appended so pagination is deterministic across pages even on a non-unique key.
 */
export function itemOrderByClause(sort: readonly ItemSort[] | undefined): string | null {
  if (sort === undefined || sort.length === 0) return null;
  const terms: string[] = [];
  for (const { field, direction } of sort) {
    const meta = ITEM_SORT_COLUMNS[field];
    const dir = direction === 'desc' ? 'DESC' : 'ASC';
    const collate = meta.collate ? ' COLLATE NOCASE' : '';
    terms.push(`(${meta.column} IS NULL)`); // non-NULL first, NULL last, either direction
    terms.push(`${meta.column}${collate} ${dir}`);
  }
  terms.push('items.id ASC'); // stable tiebreak → deterministic pagination
  return terms.join(', ');
}
