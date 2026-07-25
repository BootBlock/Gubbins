/**
 * A **constrained** OData `$filter` parser that compiles to the app's `SearchAST` — never to
 * bespoke SQL. The AST it produces is handed to `ItemRepository.searchByAst`, which runs it
 * through the one parameterised `parseASTtoSQL` translator every other read uses, so a bridge
 * `$filter` answer can never drift from the app's search semantics and carries no injection
 * surface (values are AST leaves, bound as `?` downstream).
 *
 * Supported subset (deliberately small — this is not full OData `$filter`):
 *
 *   - comparisons: `eq`, `ne`, `gt`, `lt`   (e.g. `quantity gt 10`, `name ne 'M3 Bolt'`)
 *   - the `contains(field,'text')` function (free-text CONTAINS, FTS-backed)
 *   - boolean composition: `and`, `or`, `not`, and parentheses for grouping
 *   - literals: single-quoted strings (`''` escapes a quote), numbers, `true`/`false`
 *
 * Everything else (`ge`/`le`, `startswith`/`endswith`, arithmetic, lambdas, …) is rejected
 * with a {@link BadQueryError} naming the supported operators, so the boundary is explicit.
 * Fields are validated against an allow-list mapped onto the AST's own field vocabulary — the
 * *whole* of it, so nothing the app can filter on is unreachable here (issue #143) — and an
 * unknown field is a `400`. Only *syntax* and vocabulary are checked at this layer; whether a
 * given operator is valid for a given field (`condition gt 'MINT'`, say) is the translator's
 * judgement, surfaced as a `400` when the query runs.
 *
 * `not` and `ne` both lower to the AST's negated GROUP (issue #139), so — exactly like the
 * app's `-term` syntax — they inherit its NULL-safe reading over the nullable columns:
 * `manufacturer ne 'Acme'` includes rows with *no* manufacturer recorded, which is what the
 * question means even though strict OData three-valued logic would drop them.
 */
import {
  isGroupNode,
  negated,
  type ASTGroupNode,
  type FilterCondition,
  type FilterOperator,
  type SearchAST,
} from '@/db/search/ast.ts';
import { MAX_FILTER_LENGTH } from './limits.ts';
import { BadQueryError } from './odata.ts';

/**
 * OData property name (in its published casing) → the AST field it maps to.
 *
 * This is the **whole** of the app's own scalar search vocabulary (`ITEM_FIELDS` in
 * `parseASTtoSQL`) plus its `tag` field — deliberately exhaustive, because a field the app can
 * filter on but the API cannot is a silent capability gap rather than a design choice. It had
 * become exactly that: `barcode` and `favourite` were searchable in the app yet unreachable over
 * OData, so a scanner integration could not look an item up by its GTIN (issue #143). A drift test
 * over this table and `ITEM_FIELD_NAMES` now fails the build if the two diverge again.
 *
 * Each field is reachable by the app's own short name *and*, where they differ, by the camel-cased
 * property name the read model publishes (`serialNumber`, `unitCost`, `isFavourite`, …), so a
 * caller can filter with the same spelling `$metadata` and the JSON payloads use. Matching itself
 * is case-insensitive — see {@link FIELD_LOOKUP}.
 */
const FILTERABLE_FIELDS: Readonly<Record<string, string>> = {
  // Free text (FTS-backed for `contains`).
  name: 'name',
  description: 'description',
  notes: 'notes',
  mpn: 'mpn',
  manufacturer: 'manufacturer',
  // The scanned identifier: a GTIN/UPC/EAN lookup is the whole point of an external scanner
  // integration, so `barcode eq '5012345678900'` must be expressible (issue #143).
  barcode: 'barcode',
  serialNumber: 'serial',
  serial: 'serial',
  // Foreign keys (exact match only).
  category: 'category',
  categoryId: 'category',
  location: 'location',
  locationId: 'location',
  // Numbers. Weight is canonical grams and the dimensions canonical millimetres, exactly as the
  // app's own search compares them — never the caller's display unit.
  quantity: 'quantity',
  weight: 'weight',
  width: 'width',
  height: 'height',
  depth: 'depth',
  reorder: 'reorder',
  reorderPoint: 'reorder',
  // Flags (`eq true` / `eq false`).
  favourite: 'favourite',
  isFavourite: 'favourite',
  active: 'active',
  isActive: 'active',
  // Fixed-vocabulary enums — the value must be one of the column's own allowed spellings
  // (matched case-insensitively, with spaces/hyphens read as underscores).
  condition: 'condition',
  tracking: 'tracking',
  trackingMode: 'tracking',
  deadstock: 'deadstock',
  deadStockMode: 'deadstock',
  // Calendar days, as a **quoted** `'YYYY-MM-DD'` literal: this subset has no unquoted
  // `Edm.Date` form, and an unquoted `2026-03-01` would tokenize as one malformed number.
  expiry: 'expiry',
  expiryDate: 'expiry',
  warranty: 'warranty',
  warrantyExpiresAt: 'warranty',
  // Money, compared in the base currency's **major** units (`unitCost gt 10` is ten pounds/
  // dollars, not ten of the micro-units the column stores).
  cost: 'cost',
  unitCost: 'cost',
  price: 'price',
  purchasePrice: 'price',
  value: 'value',
  currentValue: 'value',
  // Tags (issue #143). A tag has no value of its own — a tag *is* its name — so the comparison
  // is against the name and an item matches when **any** of its tags satisfies it:
  // `tag eq 'fragile'` for that exact tag, `contains(tag,'expo')` for any tag containing "expo".
  // The plural is accepted because the projected item field is called `tags`; this subset has no
  // lambda form, so `tags/any(...)` is not the spelling.
  tag: 'tag',
  tags: 'tag',
};

/**
 * The case-insensitive lookup {@link Parser.resolveField} consults — a **Map**, never the plain
 * object above.
 *
 * An object also answers to its prototype's keys, so `FILTERABLE_FIELDS['constructor']` yields a
 * *function* rather than `undefined`: the unknown-field guard would wave `constructor eq 'x'`
 * through and hand the translator a non-string field, which fails as an unhandled `500` instead of
 * the `400` that is owed. A Map has no prototype keys, so an unknown name is simply absent. (The
 * app's own field lookup guards the same hazard with `Object.hasOwn`.)
 */
const FIELD_LOOKUP: ReadonlyMap<string, string> = new Map(
  Object.entries(FILTERABLE_FIELDS).map(([name, field]) => [name.toLowerCase(), field]),
);

/**
 * The OData property names `$filter` accepts, in their published casing and sorted
 * case-insensitively — read by the OpenAPI document and the error message below so both are
 * generated from the table rather than restated beside it (a restated copy is how the API's
 * filterable set drifted from the app's in the first place, issue #143).
 *
 * Ordered by plain code-unit comparison of the lower-cased names, **not** `localeCompare`: this
 * list is embedded in the committed `openapi.yaml`, and a locale-sensitive sort would let the same
 * source emit a different document on a machine with a different ICU locale — failing the
 * no-drift test for a reason that has nothing to do with the spec. Every name here is ASCII, so a
 * code-unit sort is both stable and the order a reader expects.
 */
export const FILTERABLE_FIELD_NAMES: readonly string[] = Object.keys(FILTERABLE_FIELDS).sort((a, b) => {
  const [x, y] = [a.toLowerCase(), b.toLowerCase()];
  return x < y ? -1 : x > y ? 1 : 0;
});

/** The distinct AST fields {@link FILTERABLE_FIELDS} can reach — what the drift test checks. */
export const FILTERABLE_AST_FIELDS: readonly string[] = [...new Set(Object.values(FILTERABLE_FIELDS))];

/**
 * The published-name → AST-field pairs, for the second drift guard: **every field you can filter
 * on must also be one you can read.** Being able to select an item by its barcode but never read
 * the barcode back is half a capability, and it is how the surface came apart before (issue #143).
 * The guard is self-checking rather than a third list — it looks for a spelling of each filterable
 * field that is also a key of the projectable item registry.
 */
export const FILTERABLE_FIELD_TARGETS: readonly (readonly [name: string, field: string])[] =
  Object.entries(FILTERABLE_FIELDS);

/** OData comparison keyword → AST operator (the supported subset only). */
const COMPARISON_OPS: Readonly<Record<string, FilterOperator>> = {
  eq: 'EQUALS',
  gt: 'GREATER_THAN',
  lt: 'LESS_THAN',
};

/** Operators recognised by OData but deliberately unsupported here — rejected with a clear reason. */
const UNSUPPORTED_OPS = new Set(['ge', 'le']);

/**
 * Compile a raw `$filter` string into a {@link SearchAST}. Throws {@link BadQueryError} on any
 * syntax/vocabulary error. The result is always a GROUP root (per the §5.1 AST contract).
 */
export function parseODataFilter(raw: string): SearchAST {
  if (raw.length > MAX_FILTER_LENGTH) {
    throw new BadQueryError(`$filter is too long (max ${MAX_FILTER_LENGTH} characters).`);
  }
  const tokens = tokenize(raw);
  if (tokens.length === 0) {
    throw new BadQueryError('$filter must not be empty.');
  }
  const parser = new Parser(tokens);
  const node = parser.parseOr();
  parser.expectEnd();
  return isGroupNode(node) ? node : { type: 'GROUP', logicalOperator: 'AND', conditions: [node] };
}

// --- tokenizer --------------------------------------------------------------------

type Token =
  | { readonly kind: 'lparen' }
  | { readonly kind: 'rparen' }
  | { readonly kind: 'comma' }
  | { readonly kind: 'word'; readonly value: string }
  | { readonly kind: 'string'; readonly value: string }
  | { readonly kind: 'number'; readonly value: number };

function tokenize(raw: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < raw.length) {
    const ch = raw[i]!;
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') {
      i += 1;
      continue;
    }
    if (ch === '(') {
      tokens.push({ kind: 'lparen' });
      i += 1;
      continue;
    }
    if (ch === ')') {
      tokens.push({ kind: 'rparen' });
      i += 1;
      continue;
    }
    if (ch === ',') {
      tokens.push({ kind: 'comma' });
      i += 1;
      continue;
    }
    if (ch === "'") {
      // Single-quoted string; a doubled '' is an escaped quote (OData convention).
      let value = '';
      i += 1;
      for (;;) {
        if (i >= raw.length) throw new BadQueryError('Unterminated string literal in $filter.');
        const c = raw[i]!;
        if (c === "'") {
          if (raw[i + 1] === "'") {
            value += "'";
            i += 2;
            continue;
          }
          i += 1;
          break;
        }
        value += c;
        i += 1;
      }
      tokens.push({ kind: 'string', value });
      continue;
    }
    if (isNumberStart(ch)) {
      let j = i + 1;
      while (j < raw.length && isNumberPart(raw[j]!)) j += 1;
      const text = raw.slice(i, j);
      const value = Number(text);
      if (!Number.isFinite(value)) throw new BadQueryError(`Invalid number "${text}" in $filter.`);
      tokens.push({ kind: 'number', value });
      i = j;
      continue;
    }
    if (isWordStart(ch)) {
      let j = i + 1;
      while (j < raw.length && isWordPart(raw[j]!)) j += 1;
      tokens.push({ kind: 'word', value: raw.slice(i, j) });
      i = j;
      continue;
    }
    throw new BadQueryError(`Unexpected character "${ch}" in $filter.`);
  }
  return tokens;
}

const isNumberStart = (ch: string): boolean => (ch >= '0' && ch <= '9') || ch === '-';
const isNumberPart = (ch: string): boolean =>
  (ch >= '0' && ch <= '9') || ch === '.' || ch === 'e' || ch === 'E' || ch === '-' || ch === '+';
const isWordStart = (ch: string): boolean =>
  (ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z') || ch === '_';
const isWordPart = (ch: string): boolean => isWordStart(ch) || (ch >= '0' && ch <= '9');

// --- recursive-descent parser -----------------------------------------------------

type Node = ASTGroupNode | FilterCondition;

class Parser {
  private pos = 0;
  // Explicit field + assignment, NOT a `private readonly tokens` parameter property: the bridge
  // runs under Node's strip-only loader (see loader.mjs), which rejects parameter properties.
  private readonly tokens: readonly Token[];
  constructor(tokens: readonly Token[]) {
    this.tokens = tokens;
  }

  /** orExpr := andExpr ( 'or' andExpr )* */
  parseOr(): Node {
    const parts = [this.parseAnd()];
    while (this.matchKeyword('or')) parts.push(this.parseAnd());
    return parts.length === 1 ? parts[0]! : { type: 'GROUP', logicalOperator: 'OR', conditions: parts };
  }

  /** andExpr := primary ( 'and' primary )* */
  private parseAnd(): Node {
    const parts = [this.parsePrimary()];
    while (this.matchKeyword('and')) parts.push(this.parsePrimary());
    return parts.length === 1 ? parts[0]! : { type: 'GROUP', logicalOperator: 'AND', conditions: parts };
  }

  /** primary := 'not' primary | '(' orExpr ')' | functionCall | comparison */
  private parsePrimary(): Node {
    if (this.matchKeyword('not')) return negated(this.parsePrimary());
    if (this.peek()?.kind === 'lparen') {
      this.pos += 1;
      const node = this.parseOr();
      this.expect('rparen', ')');
      return node;
    }
    const word = this.expectWord('a field name or function');
    if (this.peek()?.kind === 'lparen') return this.parseFunction(word);
    return this.parseComparison(word);
  }

  /** comparison := field op literal */
  private parseComparison(field: string): Node {
    const opWord = this.expectWord('a comparison operator').toLowerCase();
    if (UNSUPPORTED_OPS.has(opWord)) {
      throw new BadQueryError(
        `Operator "${opWord}" is not supported in this OData subset (supported: eq, ne, gt, lt, contains, and, or, not).`,
      );
    }
    // `ne` has no AST operator of its own: it is `eq` under the negated GROUP (issue #139).
    const negate = opWord === 'ne';
    const operator = negate ? 'EQUALS' : COMPARISON_OPS[opWord];
    if (operator === undefined) {
      throw new BadQueryError(`Unknown operator "${opWord}" in $filter (supported: eq, ne, gt, lt).`);
    }
    const condition: FilterCondition = {
      field: this.resolveField(field),
      operator,
      value: this.parseLiteral(),
    };
    return negate ? negated(condition) : condition;
  }

  /** functionCall := 'contains' '(' field ',' string ')' */
  private parseFunction(name: string): FilterCondition {
    const fn = name.toLowerCase();
    this.expect('lparen', '(');
    const field = this.expectWord('a field name');
    this.expect('comma', ',');
    const value = this.parseLiteral();
    this.expect('rparen', ')');
    if (fn !== 'contains') {
      throw new BadQueryError(`Function "${name}" is not supported (only contains(field,'text') is).`);
    }
    return { field: this.resolveField(field), operator: 'CONTAINS', value };
  }

  private parseLiteral(): string | number | boolean {
    const tok = this.next();
    if (tok === undefined) throw new BadQueryError('$filter ended before a value.');
    if (tok.kind === 'string') return tok.value;
    if (tok.kind === 'number') return tok.value;
    if (tok.kind === 'word') {
      const lower = tok.value.toLowerCase();
      if (lower === 'true') return true;
      if (lower === 'false') return false;
      throw new BadQueryError(`Expected a value (quoted string, number, or boolean), got "${tok.value}".`);
    }
    throw new BadQueryError('Expected a value in $filter.');
  }

  private resolveField(name: string): string {
    const mapped = FIELD_LOOKUP.get(name.toLowerCase());
    if (mapped === undefined) {
      throw new BadQueryError(
        `Cannot filter on "${name}". Filterable fields: ${FILTERABLE_FIELD_NAMES.join(', ')}.`,
      );
    }
    return mapped;
  }

  // --- token cursor helpers ---

  private peek(): Token | undefined {
    return this.tokens[this.pos];
  }
  private next(): Token | undefined {
    return this.tokens[this.pos++];
  }
  private matchKeyword(keyword: string): boolean {
    const tok = this.peek();
    if (tok?.kind === 'word' && tok.value.toLowerCase() === keyword) {
      this.pos += 1;
      return true;
    }
    return false;
  }
  private expect(kind: Token['kind'], display: string): void {
    const tok = this.next();
    if (tok?.kind !== kind) throw new BadQueryError(`Expected "${display}" in $filter.`);
  }
  private expectWord(what: string): string {
    const tok = this.next();
    if (tok?.kind !== 'word') throw new BadQueryError(`Expected ${what} in $filter.`);
    return tok.value;
  }
  expectEnd(): void {
    if (this.pos !== this.tokens.length) {
      throw new BadQueryError('Unexpected trailing input in $filter.');
    }
  }
}
