/**
 * `parseASTtoSQL` — the single, recursive Visual-Builder translator (spec §5.1).
 *
 * Maps the §5.1 {@link SearchAST} into a **parameterised** SQL boolean expression
 * for the `WHERE` clause of a query over the `items` table (aliased as `items`).
 * It returns the strictly typed tuple `[sql, params]` the §5.1 Translation
 * Directive mandates:
 *
 *   - **String concatenation for values is forbidden.** Every value becomes a `?`
 *     placeholder with the value pushed onto `params`. The only literals embedded
 *     in the SQL text are column identifiers drawn from fixed allow-lists, never
 *     user input. Free-text matches route through the FTS5 `items_fts` index via a
 *     bound MATCH parameter (see {@link buildFtsMatch}).
 *   - **Hard recursion cap** of {@link MAX_AST_GROUP_DEPTH} nested GROUP nodes — a
 *     deeper tree throws {@link SearchAstError} rather than risking stack overflow
 *     or catastrophic backtracking.
 *   - **Negation is a group property, applied once** (issue #139). A group carrying
 *     {@link ASTGroupNode.negate} has its finished fragment wrapped in a NULL-safe `NOT`,
 *     so every predicate below it inverts — including the FTS and EXISTS forms that have
 *     no inverted spelling of their own — without a single translator knowing about it.
 *
 * The fragment is self-contained and parenthesised, so callers simply splice it in:
 *   `SELECT … FROM items WHERE <fragment> ORDER BY …`.
 * An empty (or all-empty) tree yields `'1'` — i.e. "match everything" — so the
 * Builder's initial state lists all items.
 */
import type { SqlValue } from '@/db/rpc/driver';
import { CONDITIONS, DEAD_STOCK_MODES, TRACKING_MODES } from '@/db/repositories/constants';
import { nextUtcDay } from '@/lib/calendar-days';
import { toStoredMoney } from '@/lib/money';
import {
  MAX_AST_GROUP_DEPTH,
  isGroupNode,
  type ASTGroupNode,
  type FilterCondition,
  type SearchAST,
} from './ast';
import { buildFtsMatch, isFtsColumn } from './fts';

/** A translation/validation failure in the Visual-Builder AST (spec §5.1). */
export class SearchAstError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SearchAstError';
  }
}

/** The strictly typed output tuple mandated by §5.1: `[sql, params]`. */
export type ParsedQuery = readonly [sql: string, params: SqlValue[]];

/** The capability-field prefix the AST uses, e.g. `capability:voltage` (§4, §5.1). */
const CAPABILITY_PREFIX = 'capability:';

/**
 * The custom-field prefix the AST uses, e.g. `field:Datasheet` (§4 "Categories &
 * Schema Evolution", Phase 71). The remainder is a custom-field **name**, matched
 * case-insensitively against `field_defs.name` in the global dictionary (issue #97).
 * Values (all stored as TEXT) are read from the `item_field_effective_values` view, which
 * has already applied location inheritance, so a condition lowers to an EXISTS over the
 * join `item_field_effective_values ⋈ field_defs`.
 */
const CUSTOM_FIELD_PREFIX = 'field:';

/**
 * The tag field the AST uses, `tag` (issue #138). Unlike a capability or a custom field a
 * tag has no key/value pair — a tag *is* its name — so the condition's **value** is the tag
 * name and the field identifier is the bare word. It lowers to an EXISTS over
 * `item_tags ⋈ tags`, the same shape the capability/custom-field predicates use, so an item
 * matches when *any* of its tags satisfies the comparison.
 */
const TAG_FIELD = 'tag';

/**
 * How a scalar item column is compared.
 *
 * - `fts-text` — free text; CONTAINS routes through the FTS5 index, EQUALS is exact (NOCASE).
 * - `id-text` — an exact-match foreign key (no ordering, no FTS).
 * - `numeric` — a plain number column; supports ordering comparisons.
 * - `boolean` — a 0/1 flag column; EQUALS only.
 * - `enum` — a TEXT column constrained to a fixed vocabulary (the column's own `CHECK`);
 *   EQUALS only, and the value must be one of {@link ItemFieldMeta.values}.
 * - `money` — an INTEGER column of **micro-units** (issue #286). The search value is a
 *   major-unit amount, scaled with {@link toStoredMoney} before it is bound, so
 *   `cost>10` means ten pounds/dollars, not ten micro-units.
 * - `date-ms` — a day-grained UNIX-ms column snapped to midnight UTC (issue #320).
 *   Compared as a half-open day window so a stored value carrying a time of day
 *   (an import, a bridge write) still matches the day it falls on.
 * - `date-text` — a bare `YYYY-MM-DD` TEXT column. Fixed-width ISO dates sort
 *   lexicographically in date order, so `<`/`>` are plain string comparisons.
 */
type FieldKind = 'fts-text' | 'id-text' | 'numeric' | 'boolean' | 'enum' | 'money' | 'date-ms' | 'date-text';

interface ItemFieldMeta {
  readonly column: string;
  readonly kind: FieldKind;
  /** For `enum` fields only: the exact stored values the column's `CHECK` constraint allows. */
  readonly values?: readonly string[];
}

/**
 * The known scalar item fields the Builder may filter on, mapped to their real
 * column and kind. `fts-text` columns also back CONTAINS via the FTS5 index;
 * `id-text` are exact-match foreign keys; `numeric` support ordering comparisons.
 */
const ITEM_FIELDS: Readonly<Record<string, ItemFieldMeta>> = {
  name: { column: 'items.name', kind: 'fts-text' },
  description: { column: 'items.description', kind: 'fts-text' },
  notes: { column: 'items.notes', kind: 'fts-text' },
  mpn: { column: 'items.mpn', kind: 'fts-text' },
  manufacturer: { column: 'items.manufacturer', kind: 'fts-text' },
  barcode: { column: 'items.barcode', kind: 'fts-text' },
  serial: { column: 'items.serial_number', kind: 'fts-text' },
  category: { column: 'items.category_id', kind: 'id-text' },
  location: { column: 'items.location_id', kind: 'id-text' },
  quantity: { column: 'items.quantity', kind: 'numeric' },
  // Intrinsic weight in canonical grams (issue #25) — compared numerically like quantity, so
  // `weight:>500` matches items over 500 g (the search value is always in grams, not the
  // user's display unit).
  weight: { column: 'items.weight', kind: 'numeric' },
  // Intrinsic bounding-box dimensions in canonical millimetres (issue #30) — compared
  // numerically like weight, so `width:>100` matches items wider than 100 mm (the search
  // value is always in millimetres, not the user's display unit).
  width: { column: 'items.width', kind: 'numeric' },
  height: { column: 'items.height', kind: 'numeric' },
  depth: { column: 'items.depth', kind: 'numeric' },
  // "Favourite" pin (issue #23) — a boolean flag, matched with EQUALS only, e.g.
  // `favourite:yes` for the starred items (or `favourite:no` for the rest).
  favourite: { column: 'items.is_favourite', kind: 'boolean' },
  // --- Lifecycle, valuation & stock policy (issue #140) -------------------------
  // Columns that already drive whole features but were unreachable from search: the status
  // chips could only ask fixed yes/no questions ("expiring soon"), never a comparison
  // ("expiring before March").
  //
  // Only some of these carry an index, and the three that do are **partial**: `expiry_date`
  // and `warranty_expires_at` (both `WHERE … IS NOT NULL`) and `dead_stock_mode`
  // (`WHERE dead_stock_mode <> 'inherit'`) — so `deadstock:inherit` sits outside its own index
  // — plus `is_active`. The condition, tracking-mode, money and reorder-point columns have no
  // index at all, so those predicates are a scan of the items table. That is the same cost the
  // list already pays for an unindexed filter and is fine at inventory scale, but it is worth
  // knowing before adding one of these to a hot path.
  //
  // Operational condition (§4 "Condition Tracking") — a validated enum; NULL means untracked.
  condition: { column: 'items.condition', kind: 'enum', values: CONDITIONS },
  // Tracking level (§4 "Tracking Levels") — how the item's stock is represented.
  tracking: { column: 'items.tracking_mode', kind: 'enum', values: TRACKING_MODES },
  // Dead-stock reporting opt-in (issue #92) — the item's own mode, before location inheritance
  // is resolved (that resolution is a pure seam over the location ancestry, not a column).
  deadstock: { column: 'items.dead_stock_mode', kind: 'enum', values: DEAD_STOCK_MODES },
  // Perishable expiry (day-grained UNIX-ms, midnight UTC), e.g. `expiry<2026-03-01`.
  expiry: { column: 'items.expiry_date', kind: 'date-ms' },
  // Warranty end (bare `YYYY-MM-DD` TEXT), e.g. `warranty<2027-01-01`.
  warranty: { column: 'items.warranty_expires_at', kind: 'date-text' },
  // Money columns, all stored as integer micro-units (issue #286) but searched in major units.
  cost: { column: 'items.unit_cost', kind: 'money' },
  price: { column: 'items.purchase_price', kind: 'money' },
  value: { column: 'items.current_value', kind: 'money' },
  // Per-item low-stock floor (NULL falls back to the global default), e.g. `reorder>0` for
  // the items that carry their own floor at all.
  reorder: { column: 'items.reorder_point', kind: 'numeric' },
  // Soft-deletion flag. Searching this is only meaningful because an explicit `active`
  // condition also lifts the search path's implicit "active inventory only" scope — see
  // {@link astFiltersActiveFlag}.
  active: { column: 'items.is_active', kind: 'boolean' },
};

/** The `active` field name, shared with {@link astFiltersActiveFlag} so the two can't drift. */
const ACTIVE_FIELD = 'active';

/**
 * Look a field name up in {@link ITEM_FIELDS} — via `Object.hasOwn`, never a bare index.
 *
 * A plain object also answers to its prototype's keys, so `ITEM_FIELDS['constructor']` (or
 * `'toString'`) yields a *function* rather than `undefined`: the "unknown search field" guard
 * would pass it through and the translator would emit `undefined = ?` as the column. Values are
 * always bound parameters so nothing is injectable, but the query is nonsense where a clear
 * error is owed.
 */
function itemField(field: string): ItemFieldMeta | undefined {
  return Object.hasOwn(ITEM_FIELDS, field) ? ITEM_FIELDS[field] : undefined;
}

/**
 * The values an `enum` search field accepts, or `null` when the field isn't one — the
 * Visual Builder reads this to offer a picker rather than a free-text box, so the UI's
 * vocabulary is the column's `CHECK` constraint and cannot drift from it.
 */
export function itemFieldEnumValues(field: string): readonly string[] | null {
  return itemField(field.trim())?.values ?? null;
}

interface Fragment {
  readonly sql: string;
  readonly params: SqlValue[];
}

/** Translate a §5.1 SearchAST into a parameterised `[sql, params]` tuple. */
export function parseASTtoSQL(ast: SearchAST): ParsedQuery {
  const fragment = translateGroup(ast, 1);
  if (!fragment) return ['1', []];
  return [fragment.sql, fragment.params];
}

/**
 * Collect the distinct `capability:<key>` keys a tree filters on (spec §4 Weighted
 * Capabilities, §5.1). Used to drive the "best match" ranking of {@link
 * parseASTtoSQL} results: a query that filters on capabilities can order its hits by
 * the summed weight of *those* capabilities each item carries (ItemRepository.searchByAst).
 *
 * Keys are returned lower-cased and de-duplicated (capability keys match case-insensitively
 * everywhere). Pure and recursion-safe — it does not validate depth (that is parsing's job)
 * and simply walks every node, so it never throws on a tree the parser would reject.
 */
export function collectCapabilityKeys(ast: SearchAST): string[] {
  const keys = new Set<string>();
  const visit = (node: ASTGroupNode): void => {
    for (const child of node.conditions) {
      if (isGroupNode(child)) {
        visit(child);
        continue;
      }
      const field = child.field.trim();
      if (field.toLowerCase().startsWith(CAPABILITY_PREFIX)) {
        const key = field.slice(CAPABILITY_PREFIX.length).trim().toLowerCase();
        if (key.length > 0) keys.add(key);
      }
    }
  };
  visit(ast);
  return [...keys];
}

/**
 * True when a tree filters on the `active` field anywhere (issue #140).
 *
 * The AST search path scopes every query to active inventory (`AND items.is_active = 1`) unless
 * the caller opts out, which would quietly reduce an explicit `active:no` to "no results" — the
 * one predicate the implicit scope contradicts. `ItemRepository.searchByAst` therefore drops the
 * implicit clause when this returns true, letting the user's own condition decide. Every *other*
 * query keeps the scope untouched, so the default stays "active inventory only".
 *
 * Pure and recursion-safe, exactly like {@link collectCapabilityKeys}: it walks the whole tree
 * without validating depth, so it never throws on a tree the parser would reject.
 */
export function astFiltersActiveFlag(ast: SearchAST): boolean {
  const visit = (node: ASTGroupNode): boolean =>
    node.conditions.some((child) =>
      // Matched exactly as `translateCondition` looks the field up (`ITEM_FIELDS[field.trim()]`),
      // so the flag can never be set by a spelling the translator would reject as unknown.
      isGroupNode(child) ? visit(child) : child.field.trim() === ACTIVE_FIELD,
    );
  return visit(ast);
}

/**
 * Translate one GROUP node. Returns `null` when it contributes no predicate (an
 * empty group, or one whose children are all empty) so it vanishes from the parent
 * rather than degenerating an `OR` into "match all".
 */
function translateGroup(node: ASTGroupNode, depth: number): Fragment | null {
  // Guard structurally, before descending, so even an empty over-deep group throws.
  if (depth > MAX_AST_GROUP_DEPTH) {
    throw new SearchAstError(
      `Search is nested too deeply: a maximum of ${MAX_AST_GROUP_DEPTH} nested groups is allowed (spec §5.1).`,
    );
  }

  const parts: string[] = [];
  const params: SqlValue[] = [];
  for (const child of node.conditions) {
    const fragment = isGroupNode(child) ? translateGroup(child, depth + 1) : translateCondition(child);
    if (!fragment) continue;
    parts.push(fragment.sql);
    params.push(...fragment.params);
  }

  if (parts.length === 0) return null;
  const joiner = node.logicalOperator === 'OR' ? ' OR ' : ' AND ';
  const sql = `(${parts.join(joiner)})`;
  if (!node.negate) return { sql, params };

  // Negation (issue #139) wraps the *whole* group once, so it inverts FTS matches and EXISTS
  // subqueries alike without any predicate translator knowing about it.
  //
  // COALESCE is what makes it mean what a person means. Most of the columns above are nullable,
  // and SQL three-valued logic makes `items.manufacturer = ?` NULL — not false — for an item with
  // no manufacturer recorded, with `NOT NULL` still NULL. A plain `NOT (…)` would therefore
  // quietly *drop* every such item from "not made by Acme", which is the opposite of what was
  // asked. Folding NULL to 0 first reads absence as "doesn't match", so its negation is "does
  // match" — the answer the question was after.
  return { sql: `(NOT COALESCE(${sql}, 0))`, params };
}

/** Translate a single leaf condition. */
function translateCondition(condition: FilterCondition): Fragment {
  const field = condition.field.trim();
  if (field.length === 0) {
    throw new SearchAstError('A search condition is missing its field.');
  }

  if (field.toLowerCase().startsWith(CAPABILITY_PREFIX)) {
    return translateCapability(field.slice(CAPABILITY_PREFIX.length).trim(), condition);
  }

  if (field.toLowerCase().startsWith(CUSTOM_FIELD_PREFIX)) {
    return translateCustomField(field.slice(CUSTOM_FIELD_PREFIX.length).trim(), condition);
  }

  if (field.toLowerCase() === TAG_FIELD) {
    return translateTag(condition);
  }

  const meta = itemField(field);
  if (!meta) {
    throw new SearchAstError(`Unknown search field "${condition.field}".`);
  }
  return translateItemField(meta, condition);
}

/** Translate a scalar item-column condition (name/category/quantity…). */
function translateItemField(meta: ItemFieldMeta, condition: FilterCondition): Fragment {
  const { column, kind } = meta;
  const { operator, value } = condition;

  switch (operator) {
    case 'CONTAINS': {
      if (kind !== 'fts-text') {
        throw unsupported(operator, condition.field);
      }
      // Route free-text CONTAINS through the FTS5 index, scoped to this column.
      const ftsColumn = column.replace(/^items\./, '');
      const match = isFtsColumn(ftsColumn) ? buildFtsMatch(String(value), ftsColumn) : null;
      if (match === null) {
        // No usable tokens → a predicate that matches nothing.
        return { sql: '0', params: [] };
      }
      return {
        sql: 'items.rowid IN (SELECT rowid FROM items_fts WHERE items_fts MATCH ?)',
        params: [match],
      };
    }
    case 'EQUALS': {
      if (kind === 'boolean') {
        // A 0/1 flag column — match the stored integer, coercing the AST value to a strict boolean.
        return { sql: `${column} = ?`, params: [toBoolean(value, condition.field) ? 1 : 0] };
      }
      if (kind === 'numeric') {
        return { sql: `${column} = ?`, params: [toNumber(value, condition.field)] };
      }
      if (kind === 'money') {
        return { sql: `${column} = ?`, params: [toStoredAmount(value, condition.field)] };
      }
      if (kind === 'enum') {
        // Canonicalised to the stored spelling, so no COLLATE is needed (or wanted — the
        // column's CHECK vocabulary is exact).
        return { sql: `${column} = ?`, params: [toEnumValue(value, meta, condition.field)] };
      }
      if (kind === 'date-text') {
        return { sql: `${column} = ?`, params: [toCalendarDay(value, condition.field).text] };
      }
      if (kind === 'date-ms') {
        // Half-open day window: "on this day", whatever time of day the stored instant carries.
        const [start, end] = dayWindow(value, condition.field);
        return { sql: `(${column} >= ? AND ${column} < ?)`, params: [start, end] };
      }
      // Text/id equality is case-insensitive.
      return { sql: `${column} = ? COLLATE NOCASE`, params: [String(value)] };
    }
    case 'GREATER_THAN':
    case 'LESS_THAN': {
      const sign = operator === 'GREATER_THAN' ? '>' : '<';
      if (kind === 'numeric') {
        return { sql: `${column} ${sign} ?`, params: [toNumber(value, condition.field)] };
      }
      if (kind === 'money') {
        return { sql: `${column} ${sign} ?`, params: [toStoredAmount(value, condition.field)] };
      }
      if (kind === 'date-text') {
        // Fixed-width `YYYY-MM-DD` sorts lexicographically in date order, and a bare day never
        // carries a time, so a plain string comparison is already "strictly before/after that day".
        return { sql: `${column} ${sign} ?`, params: [toCalendarDay(value, condition.field).text] };
      }
      if (kind === 'date-ms') {
        // Compare against the *day* boundaries so "after 1 March" excludes 1 March itself even
        // when a stored instant carries a time of day.
        const [start, end] = dayWindow(value, condition.field);
        return operator === 'GREATER_THAN'
          ? { sql: `${column} >= ?`, params: [end] }
          : { sql: `${column} < ?`, params: [start] };
      }
      throw unsupported(operator, condition.field);
    }
    case 'HAS_CAPABILITY': {
      // Reused as the generic *presence* operator (as it already is for custom fields): "this
      // item has a value for this field at all". Pairs with group negation to answer "anything
      // without a category" / "items with no part number" (issue #139). A cleared text field is
      // stored as an empty string as often as NULL, so both count as absent.
      const blankIsAbsent = kind === 'fts-text' || kind === 'id-text';
      return {
        sql: blankIsAbsent ? `(${column} IS NOT NULL AND TRIM(${column}) <> '')` : `${column} IS NOT NULL`,
        params: [],
      };
    }
    default:
      throw unsupported(operator, condition.field);
  }
}

/**
 * Translate a `capability:<key>` condition into an EXISTS subquery over the
 * `capabilities` table (spec §4 Weighted Capabilities). The key and value are both
 * bound parameters.
 */
function translateCapability(key: string, condition: FilterCondition): Fragment {
  if (key.length === 0) {
    throw new SearchAstError('A capability condition is missing its key (expected "capability:<key>").');
  }
  const { operator, value } = condition;
  const base = 'SELECT 1 FROM capabilities c WHERE c.item_id = items.id AND c.key = ? COLLATE NOCASE';

  switch (operator) {
    case 'HAS_CAPABILITY':
      return { sql: `EXISTS (${base})`, params: [key] };
    case 'GREATER_THAN':
    case 'LESS_THAN': {
      const sign = operator === 'GREATER_THAN' ? '>' : '<';
      return {
        sql: `EXISTS (${base} AND c.value_num ${sign} ?)`,
        params: [key, toNumber(value, condition.field)],
      };
    }
    case 'EQUALS': {
      if (typeof value === 'number') {
        return { sql: `EXISTS (${base} AND c.value_num = ?)`, params: [key, value] };
      }
      return {
        sql: `EXISTS (${base} AND c.value_text = ? COLLATE NOCASE)`,
        params: [key, String(value)],
      };
    }
    case 'CONTAINS': {
      return {
        sql: `EXISTS (${base} AND c.value_text LIKE ? ESCAPE '\\')`,
        params: [key, `%${escapeLike(String(value))}%`],
      };
    }
    default:
      throw unsupported(operator, condition.field);
  }
}

/**
 * Translate a `field:<name>` condition into an EXISTS subquery over the join of the
 * EAV `item_field_values` value rows and their `category_fields` definitions (spec §4
 * "Categories & Schema Evolution", Phase 71). The custom field is resolved by its
 * definition **name** (case-insensitive), both the name and the compared value are
 * bound parameters.
 *
 * Because the field name is matched inside the subquery, an **unknown/missing** field
 * name produces a valid predicate that simply matches no rows (no-match, never an
 * error) — exactly the §5.1 requirement. All values persist as TEXT in
 * `item_field_values.value`; numeric comparisons therefore cast the stored text to a
 * REAL so `GREATER_THAN`/`LESS_THAN` order numerically rather than lexically.
 */
function translateCustomField(name: string, condition: FilterCondition): Fragment {
  if (name.length === 0) {
    throw new SearchAstError('A custom-field condition is missing its name (expected "field:<name>").');
  }
  const { operator, value } = condition;
  // Resolve against the *effective* value view (issue #97), not the raw value rows, so a
  // field the item inherits from its location matches exactly as a stored one does. The
  // field is identified by its dictionary-definition name (case-insensitive).
  const base =
    'SELECT 1 FROM item_field_effective_values ifv JOIN field_defs fd ON fd.id = ifv.def_id ' +
    // Never match against an IMAGE field's value: it holds a base64 `data:` URL, not
    // searchable text, so a text/number predicate over it is meaningless (issue #453).
    "WHERE ifv.item_id = items.id AND fd.name = ? COLLATE NOCASE AND fd.field_type <> 'IMAGE'";

  switch (operator) {
    case 'HAS_CAPABILITY':
      // Presence: the item carries a non-NULL value for the named field.
      return { sql: `EXISTS (${base} AND ifv.value IS NOT NULL)`, params: [name] };
    case 'GREATER_THAN':
    case 'LESS_THAN': {
      const sign = operator === 'GREATER_THAN' ? '>' : '<';
      return {
        sql: `EXISTS (${base} AND CAST(ifv.value AS REAL) ${sign} ?)`,
        params: [name, toNumber(value, condition.field)],
      };
    }
    case 'EQUALS': {
      if (typeof value === 'number') {
        return { sql: `EXISTS (${base} AND CAST(ifv.value AS REAL) = ?)`, params: [name, value] };
      }
      return {
        sql: `EXISTS (${base} AND ifv.value = ? COLLATE NOCASE)`,
        params: [name, String(value)],
      };
    }
    case 'CONTAINS': {
      return {
        sql: `EXISTS (${base} AND ifv.value LIKE ? ESCAPE '\\')`,
        params: [name, `%${escapeLike(String(value))}%`],
      };
    }
    default:
      throw unsupported(operator, condition.field);
  }
}

/**
 * Translate a `tag` condition into an EXISTS subquery over the item↔tag join (issue #138).
 * Tags are a shared dictionary of names with no value of their own, so the condition's value
 * is the tag **name**: `CONTAINS` matches it as a substring (so `tag:expo` finds `expo-2026`)
 * and `EQUALS` matches the whole name. Both are case-insensitive, matching how the tag
 * dictionary itself de-duplicates names (`Fragile` and `fragile` are one tag).
 *
 * An item matches when **any** of its tags satisfies the comparison, and the name is a bound
 * parameter. Only the item's own tags are considered — a tag on its *location* is a property
 * of that location, not of the items inside it. As with the other LIKE-based translators an
 * empty `CONTAINS` value degenerates to "carries any tag at all" rather than matching nothing.
 */
function translateTag(condition: FilterCondition): Fragment {
  const { operator, value } = condition;
  const base = 'SELECT 1 FROM item_tags it JOIN tags tg ON tg.id = it.tag_id WHERE it.item_id = items.id';

  switch (operator) {
    case 'CONTAINS':
      return {
        sql: `EXISTS (${base} AND tg.name LIKE ? ESCAPE '\\')`,
        params: [`%${escapeLike(String(value))}%`],
      };
    case 'EQUALS':
      return { sql: `EXISTS (${base} AND tg.name = ? COLLATE NOCASE)`, params: [String(value)] };
    default:
      throw unsupported(operator, condition.field);
  }
}

function unsupported(operator: string, field: string): SearchAstError {
  return new SearchAstError(`Operator ${operator} is not supported for field "${field}".`);
}

/**
 * Interpret an AST value as a strict boolean, or `null` when it isn't a recognised yes/no. Accepts a
 * real boolean, `1`/`0`, and the usual truthy/falsy words (`true`/`false`, `yes`/`no`, `y`/`n`,
 * `on`/`off`) case-insensitively. Exported so the text-query parser ({@link parse-text-query})
 * canonicalises `favourite:yes` through the **same** vocabulary the SQL layer coerces with — one
 * definition, no drift between the two layers.
 */
export function parseBooleanValue(value: string | number | boolean): boolean | null {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  const v = value.trim().toLowerCase();
  if (['true', 'yes', 'y', '1', 'on'].includes(v)) return true;
  if (['false', 'no', 'n', '0', 'off'].includes(v)) return false;
  return null;
}

/** Coerce an AST value to a strict boolean, or throw a typed error. */
function toBoolean(value: string | number | boolean, field: string): boolean {
  const parsed = parseBooleanValue(value);
  if (parsed === null) {
    throw new SearchAstError(`Field "${field}" needs a yes/no value, received "${String(value)}".`);
  }
  return parsed;
}

/**
 * Canonicalise an AST value to one of an `enum` field's stored values, or throw a typed error
 * naming the vocabulary. Matching is case-insensitive and treats spaces and hyphens as
 * underscores, so `needs repair`, `needs-repair` and `NEEDS_REPAIR` all reach the stored
 * `NEEDS_REPAIR` — while the *returned* value is always the column's own spelling, which differs
 * in case between enums (`MINT` vs `inherit`).
 */
function toEnumValue(value: string | number | boolean, meta: ItemFieldMeta, field: string): string {
  const allowed = meta.values ?? [];
  const wanted = normaliseEnumToken(String(value));
  const match = allowed.find((candidate) => normaliseEnumToken(candidate) === wanted);
  if (match === undefined) {
    throw new SearchAstError(`Field "${field}" accepts ${allowed.join(', ')}, received "${String(value)}".`);
  }
  return match;
}

/** Fold an enum token to its comparison form: case-insensitive, hyphens/spaces as underscores. */
function normaliseEnumToken(value: string): string {
  return value
    .trim()
    .toUpperCase()
    .replace(/[\s-]+/g, '_');
}

/**
 * Canonicalise a value to one of an `enum` field's stored spellings, or `null` when the field
 * isn't an enum or the value isn't in its vocabulary.
 *
 * Exported for the same reason {@link parseBooleanValue} is: the text-query parser canonicalises
 * through the **same** vocabulary the SQL layer coerces with, so the two can't drift — and so the
 * tree it loads into the Visual Builder already carries the spelling that field's picker offers.
 * Without it `condition:mint` would still run correctly but leave the picker blank, because a
 * `Select` whose value matches no option renders its placeholder instead.
 */
export function parseEnumValue(field: string, value: string | number | boolean): string | null {
  const allowed = itemFieldEnumValues(field);
  if (allowed === null) return null;
  const wanted = normaliseEnumToken(String(value));
  return allowed.find((candidate) => normaliseEnumToken(candidate) === wanted) ?? null;
}

/** Coerce an AST value to the integer micro-units a money column stores (issue #286). */
function toStoredAmount(value: string | number | boolean, field: string): number {
  return toStoredMoney(toNumber(value, field));
}

/** A validated calendar day: its canonical `YYYY-MM-DD` text and its midnight-UTC instant. */
interface CalendarDay {
  readonly text: string;
  readonly startMs: number;
}

/**
 * Coerce an AST value to a calendar day, or throw a typed error.
 *
 * Deliberately strict — only the bare ISO day form is accepted, and its fields must round-trip
 * through `Date.UTC` unchanged. `Date.parse` alone is not enough: it happily reads `2026-02-31`
 * as 2 March, so a typo'd day would silently filter on a *different* day than the one asked for.
 * This is the same rule the write path applies to `warranty_expires_at` (issue #327); rejecting
 * a locale-shaped `01/03/2026` outright likewise beats guessing which of the two numbers is the
 * month.
 */
function toCalendarDay(value: string | number | boolean, field: string): CalendarDay {
  const text = String(value).trim();
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (match) {
    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);
    const startMs = Date.UTC(year, month - 1, day);
    const parsed = new Date(startMs);
    if (
      parsed.getUTCFullYear() === year &&
      parsed.getUTCMonth() === month - 1 &&
      parsed.getUTCDate() === day
    ) {
      return { text, startMs };
    }
  }
  throw new SearchAstError(`Field "${field}" needs a date as YYYY-MM-DD, received "${String(value)}".`);
}

/**
 * The half-open `[start, end)` UNIX-ms window naming the calendar day an AST value picks — the
 * comparison unit for a day-grained UTC column (issue #320). Day-grained values are stored at
 * midnight UTC, so this is normally a one-instant window; going through the boundaries anyway
 * keeps the predicate correct for a row whose value carries a time of day.
 */
function dayWindow(value: string | number | boolean, field: string): [start: number, end: number] {
  const { startMs } = toCalendarDay(value, field);
  return [startMs, nextUtcDay(startMs)];
}

/** Coerce an AST value to a finite number, or throw a typed error. */
function toNumber(value: string | number | boolean, field: string): number {
  const n = typeof value === 'boolean' ? (value ? 1 : 0) : Number(value);
  if (!Number.isFinite(n)) {
    throw new SearchAstError(`Field "${field}" needs a numeric value, received "${String(value)}".`);
  }
  return n;
}

/** Escape LIKE wildcards so a capability text value is matched literally. */
function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}
