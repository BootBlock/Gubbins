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
 *
 * The fragment is self-contained and parenthesised, so callers simply splice it in:
 *   `SELECT … FROM items WHERE <fragment> ORDER BY …`.
 * An empty (or all-empty) tree yields `'1'` — i.e. "match everything" — so the
 * Builder's initial state lists all items.
 */
import type { SqlValue } from '@/db/rpc/driver';
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
 * Schema Evolution", Phase 71). The remainder is a category custom-field **name**,
 * matched case-insensitively against `category_fields.name`. Values live in the EAV
 * `item_field_values` table (all stored as TEXT), so a custom-field condition lowers
 * to an EXISTS over the join `item_field_values ⋈ category_fields`.
 */
const CUSTOM_FIELD_PREFIX = 'field:';

type FieldKind = 'fts-text' | 'id-text' | 'numeric';

/**
 * The known scalar item fields the Builder may filter on, mapped to their real
 * column and kind. `fts-text` columns also back CONTAINS via the FTS5 index;
 * `id-text` are exact-match foreign keys; `numeric` support ordering comparisons.
 */
const ITEM_FIELDS: Readonly<Record<string, { column: string; kind: FieldKind }>> = {
  name: { column: 'items.name', kind: 'fts-text' },
  description: { column: 'items.description', kind: 'fts-text' },
  mpn: { column: 'items.mpn', kind: 'fts-text' },
  manufacturer: { column: 'items.manufacturer', kind: 'fts-text' },
  category: { column: 'items.category_id', kind: 'id-text' },
  location: { column: 'items.location_id', kind: 'id-text' },
  quantity: { column: 'items.quantity', kind: 'numeric' },
};

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
    const fragment = isGroupNode(child)
      ? translateGroup(child, depth + 1)
      : translateCondition(child);
    if (!fragment) continue;
    parts.push(fragment.sql);
    params.push(...fragment.params);
  }

  if (parts.length === 0) return null;
  const joiner = node.logicalOperator === 'OR' ? ' OR ' : ' AND ';
  return { sql: `(${parts.join(joiner)})`, params };
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

  const meta = ITEM_FIELDS[field];
  if (!meta) {
    throw new SearchAstError(`Unknown search field "${condition.field}".`);
  }
  return translateItemField(meta.column, meta.kind, condition);
}

/** Translate a scalar item-column condition (name/category/quantity…). */
function translateItemField(column: string, kind: FieldKind, condition: FilterCondition): Fragment {
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
      if (kind === 'numeric') {
        return { sql: `${column} = ?`, params: [toNumber(value, condition.field)] };
      }
      // Text/id equality is case-insensitive.
      return { sql: `${column} = ? COLLATE NOCASE`, params: [String(value)] };
    }
    case 'GREATER_THAN':
    case 'LESS_THAN': {
      if (kind !== 'numeric') {
        throw unsupported(operator, condition.field);
      }
      const sign = operator === 'GREATER_THAN' ? '>' : '<';
      return { sql: `${column} ${sign} ?`, params: [toNumber(value, condition.field)] };
    }
    case 'HAS_CAPABILITY':
      throw new SearchAstError(
        `HAS_CAPABILITY applies only to capability fields, not "${condition.field}".`,
      );
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
  // Join the value row to its definition by category-field name (case-insensitive).
  const base =
    'SELECT 1 FROM item_field_values ifv JOIN category_fields cf ON cf.id = ifv.field_id ' +
    'WHERE ifv.item_id = items.id AND cf.name = ? COLLATE NOCASE';

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

function unsupported(operator: string, field: string): SearchAstError {
  return new SearchAstError(`Operator ${operator} is not supported for field "${field}".`);
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
