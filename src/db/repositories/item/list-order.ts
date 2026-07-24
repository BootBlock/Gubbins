/**
 * The single source of truth for the item-list ordering and its **keyset (seek) cursor**
 * (issue #172).
 *
 * The inventory list historically paged with `LIMIT ? OFFSET ?`: SQLite must produce and
 * discard every row before the offset, so page 1000 of a 100k list scans ~50k rows to return
 * 50. Keyset pagination replaces the offset with a *seek predicate* — "give me the page that
 * starts strictly after this row's sort key" — which, backed by the ordering index, makes
 * every page constant-cost regardless of depth.
 *
 * A seek predicate is only correct if it is derived from the *exact same* ordering the query
 * sorts by, so both are built here from one {@link OrderTerm}[] spec. The spec is a total
 * order (it always ends with the unique `items.id` tiebreak), which keyset pagination requires
 * — a non-unique key could skip or duplicate rows at a page boundary.
 *
 * The offset path (discrete pagination — issue #20 — and the grouped location sections) is left
 * untouched and still passes an `offset`; only the infinite-scroll read seeks. Both, however,
 * order through {@link renderOrderBy} so the cursor a seek page carries always matches the sort.
 */
import type { SqlValue } from '../../rpc/driver';
import type { ItemRow } from '../types';
import { ITEM_SORT_COLUMNS, type ItemSort, type ItemSortField } from './sql';

/**
 * A single cursor component — the stored value of one ordering column for a boundary row.
 * Deliberately the SQL scalar primitives only (item sort keys are text, integers or NULL —
 * never a blob), so a cursor is a plain, structurally-cloneable array with no driver coupling.
 */
export type CursorValue = string | number | null;

/** An opaque keyset cursor: the ordering-column values of one boundary row, in spec order. */
export type Cursor = readonly CursorValue[];

/** Where NULLs sort relative to the non-NULL values for one ordering term. */
type NullsPlacement = 'first' | 'last' | 'none';

/** One ordering term: the column, how it sorts, and which raw {@link ItemRow} field feeds the cursor. */
interface OrderTerm {
  /** The column expression as it appears in SQL, e.g. `items.name`. Never free user input. */
  readonly sql: string;
  /** The raw {@link ItemRow} field the cursor value is read from — kept in lockstep with `sql`. */
  readonly rowKey: keyof ItemRow;
  readonly direction: 'asc' | 'desc';
  /** Whether the column collates case-insensitively (matches the `ORDER BY` collation). */
  readonly collate: boolean;
  /**
   * Where NULLs fall. `'none'` for a `NOT NULL` column (id, name, created_at, is_favourite);
   * `'first'` reproduces SQLite's default ASC placement (the un-guarded default order);
   * `'last'` matches the explicit-sort builder's `(col IS NULL)` guard.
   */
  readonly nulls: NullsPlacement;
}

/** Map a whitelisted sort field to the raw `ItemRow` column its cursor value is read from. */
const SORT_FIELD_ROW_KEY: Readonly<Record<ItemSortField, keyof ItemRow>> = {
  name: 'name',
  quantity: 'quantity',
  unitCost: 'unit_cost',
  mpn: 'mpn',
  manufacturer: 'manufacturer',
  createdAt: 'created_at',
  updatedAt: 'updated_at',
  serialNo: 'serial_no',
};

/**
 * The lead term: favourited items (issue #23) float to the top ahead of everything else, whatever
 * ordering follows (`is_favourite` is 1 for a favourite, 0 otherwise → DESC puts 1 first).
 */
const FAVOURITE_FIRST_TERM: OrderTerm = {
  sql: 'items.is_favourite',
  rowKey: 'is_favourite',
  direction: 'desc',
  collate: false,
  nulls: 'none',
};

/** The unique tiebreak that makes the ordering a total order — required for a correct seek. */
const ID_TIEBREAK_TERM: OrderTerm = {
  sql: 'items.id',
  rowKey: 'id',
  direction: 'asc',
  collate: false,
  nulls: 'none',
};

/**
 * The default ordering terms when the caller requests no explicit sort: name, then the
 * SERIALISED-clone instance index, then creation order. Reproduces the historical default
 * `name COLLATE NOCASE ASC, serial_no ASC, created_at ASC` exactly — `serial_no` keeps SQLite's
 * un-guarded ASC NULLs-first placement so the rendered `ORDER BY` is byte-identical.
 */
const DEFAULT_TERMS: readonly OrderTerm[] = [
  { sql: 'items.name', rowKey: 'name', direction: 'asc', collate: true, nulls: 'none' },
  { sql: 'items.serial_no', rowKey: 'serial_no', direction: 'asc', collate: false, nulls: 'first' },
  { sql: 'items.created_at', rowKey: 'created_at', direction: 'asc', collate: false, nulls: 'none' },
];

/**
 * Resolve the full ordering spec for a list read: the favourites-first lead, then the caller's
 * explicit sort (each term NULLs-last, matching {@link itemOrderByClause}) or the default order,
 * and finally the unique `items.id` tiebreak. This one spec drives both the `ORDER BY`
 * ({@link renderOrderBy}) and the seek predicate ({@link buildSeekPredicate}).
 */
export function resolveItemOrder(sort: readonly ItemSort[] | undefined): OrderTerm[] {
  const terms: OrderTerm[] = [FAVOURITE_FIRST_TERM];
  if (sort && sort.length > 0) {
    for (const { field, direction } of sort) {
      const meta = ITEM_SORT_COLUMNS[field];
      terms.push({
        sql: meta.column,
        rowKey: SORT_FIELD_ROW_KEY[field],
        direction,
        collate: meta.collate,
        // The explicit-sort builder forces NULLs last regardless of direction (SQLite would put
        // them first on DESC); mirror that so the cursor's NULL handling agrees with the order.
        nulls: 'last',
      });
    }
  } else {
    terms.push(...DEFAULT_TERMS);
  }
  terms.push(ID_TIEBREAK_TERM);
  return terms;
}

/** Render one term's `ORDER BY` fragment (with its NULLs-last guard and collation). */
function renderTerm(term: OrderTerm): string {
  const dir = term.direction === 'desc' ? 'DESC' : 'ASC';
  const collate = term.collate ? ' COLLATE NOCASE' : '';
  // A `(col IS NULL)` guard sorts non-NULL (false→0) before NULL (true→1), i.e. NULLs last, either
  // direction. `'first'`/`'none'` need no guard — SQLite's ASC default already puts NULLs first.
  const guard = term.nulls === 'last' ? `(${term.sql} IS NULL), ` : '';
  return `${guard}${term.sql}${collate} ${dir}`;
}

/** Render the `ORDER BY` column list for a resolved spec (the text after `ORDER BY`). */
export function renderOrderBy(terms: readonly OrderTerm[]): string {
  return terms.map(renderTerm).join(', ');
}

/**
 * Reverse a resolved ordering — every direction flipped and NULLs placement mirrored — so a
 * backward (scroll-up) seek can reuse the forward "strictly after" machinery: seeking *after* a
 * cursor in the reversed order yields the rows *before* it in the forward order. The caller runs
 * the read with this reversed `ORDER BY` and then reverses the returned rows back to forward order.
 */
export function reverseOrder(terms: readonly OrderTerm[]): OrderTerm[] {
  return terms.map((term) => ({
    ...term,
    direction: term.direction === 'asc' ? 'desc' : 'asc',
    nulls: term.nulls === 'first' ? 'last' : term.nulls === 'last' ? 'first' : 'none',
  }));
}

/** Extract the cursor (ordering-column values, in spec order) for a boundary row. */
export function extractCursor(row: ItemRow, terms: readonly OrderTerm[]): Cursor {
  return terms.map((term) => row[term.rowKey] as CursorValue);
}

/** SQL comparing `col` for equality with a known **non-NULL** cursor value, honouring collation. */
function termEqualsSql(term: OrderTerm): string {
  // A NULL `col` yields NULL here (not true), so the row simply fails this equality and is picked
  // up — if it belongs after the cursor — by the disjunct at this term's own position instead.
  return term.collate ? `${term.sql} = ? COLLATE NOCASE` : `${term.sql} = ?`;
}

/**
 * SQL for "`col` sorts strictly **after** this cursor value" at one term, or `null` when nothing
 * can — a NULL value in a NULLs-last column is the maximum, so no row follows it at that position
 * (continuation there is left to the tiebreak terms). The value is known at build time, so the
 * NULL/non-NULL branch is resolved here rather than in SQL.
 */
function termAfterSql(term: OrderTerm, value: CursorValue): { sql: string; params: SqlValue[] } | null {
  if (value === null) {
    // Only a NULLs-first column has anything after a NULL: the non-NULL rows.
    return term.nulls === 'first' ? { sql: `${term.sql} IS NOT NULL`, params: [] } : null;
  }
  const cmp = term.direction === 'desc' ? '<' : '>';
  const collate = term.collate ? ' COLLATE NOCASE' : '';
  const compare = `${term.sql} ${cmp} ?${collate}`;
  // With NULLs last, NULLs sort *after* any non-NULL value, so a NULL row is also "after".
  const sql = term.nulls === 'last' ? `(${compare} OR ${term.sql} IS NULL)` : compare;
  return { sql, params: [value] };
}

/**
 * Build the keyset seek predicate for "the row sorts strictly after `cursor`" under `terms`, as a
 * lexicographic OR-of-prefixes: for each term *i*, all earlier terms tie **and** term *i* is
 * strictly after. The cursor row itself ties on every term (the unique id tiebreak guarantees a
 * strict decision for any other row), so it is never re-emitted — no duplicate at the boundary.
 *
 * Pass a reversed spec ({@link reverseOrder}) to get a backward seek. Returns a bracketed SQL
 * fragment plus its bound params (in SQL text order), ready to `AND` into the list `WHERE`.
 */
export function buildSeekPredicate(
  terms: readonly OrderTerm[],
  cursor: Cursor,
): { sql: string; params: SqlValue[] } {
  const disjuncts: string[] = [];
  const params: SqlValue[] = [];
  for (let i = 0; i < terms.length; i += 1) {
    // `cursor` is aligned with `terms` (both come from the same spec), so index access is in range.
    const after = termAfterSql(terms[i]!, cursor[i]!);
    if (after === null) continue; // This position can contribute no "after" — skip the disjunct.
    const conj: string[] = [];
    for (let j = 0; j < i; j += 1) {
      const value = cursor[j]!;
      if (value === null) {
        conj.push(`${terms[j]!.sql} IS NULL`);
      } else {
        conj.push(termEqualsSql(terms[j]!));
        params.push(value);
      }
    }
    conj.push(after.sql);
    params.push(...after.params);
    disjuncts.push(conj.length === 1 ? conj[0]! : `(${conj.join(' AND ')})`);
  }
  // No disjunct means nothing can follow the cursor (an all-NULLs-last cursor with no id term) —
  // impossible in practice because the id tiebreak is NOT NULL and unique, but stay total anyway.
  return { sql: disjuncts.length > 0 ? `(${disjuncts.join(' OR ')})` : '0', params };
}
