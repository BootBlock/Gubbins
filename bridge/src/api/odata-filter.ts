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
 * Fields are validated against a small allow-list mapped onto the AST's own field vocabulary;
 * an unknown field is a `400`.
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
 * OData property name (lower-cased) → the AST field it maps to. Exported so the drift guard on
 * {@link FILTERABLE_PROPERTIES} can check both directions — no property claimed filterable that
 * isn't, and no filterable AST field left out of the metadata.
 */
export const FIELD_MAP: Readonly<Record<string, string>> = {
  name: 'name',
  description: 'description',
  notes: 'notes',
  mpn: 'mpn',
  manufacturer: 'manufacturer',
  serialnumber: 'serial',
  serial: 'serial',
  quantity: 'quantity',
  weight: 'weight',
  width: 'width',
  height: 'height',
  depth: 'depth',
  category: 'category',
  categoryid: 'category',
  location: 'location',
  locationid: 'location',
};

/**
 * The CSDL property names `$filter` accepts, in their canonical spelling.
 *
 * {@link FIELD_MAP} is keyed by the *lower-cased* name (so a caller's `SerialNumber` resolves)
 * and carries convenience aliases (`serial`, `category`, `location`) that are not properties of
 * the entity type. The metadata document needs the real property names, and only those, for its
 * `Org.OData.Capabilities.V1.FilterRestrictions` annotation — a client trusting it must not be
 * told to push down a filter on a name the entity type never declares. A unit test asserts every
 * entry here still resolves through `FIELD_MAP`, so the two cannot drift apart.
 */
export const FILTERABLE_PROPERTIES: readonly string[] = [
  'name',
  'description',
  'notes',
  'mpn',
  'manufacturer',
  'serialNumber',
  'quantity',
  'weight',
  'width',
  'height',
  'depth',
  'categoryId',
  'locationId',
];

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
    const mapped = FIELD_MAP[name.toLowerCase()];
    if (mapped === undefined) {
      throw new BadQueryError(
        `Cannot filter on "${name}". Filterable fields: ${[...new Set(Object.values(FIELD_MAP))].join(', ')}.`,
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
