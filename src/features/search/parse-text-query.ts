/**
 * The hybrid power-user text-search parser (spec §3 Advanced Search "hybrid
 * text-based syntax", e.g. `cap:voltage>3.3`) — Phase 47, deepened in Phase 48.
 *
 * It turns a query string into the **exact** {@link SearchAST} the Visual Builder
 * edits, so the text box and the graphical builder share one Tier-3 tree and one
 * search path (`parseASTtoSQL` → FTS): typing a query merely *loads* the builder.
 * Pure and unit-tested over the AST output; no React, no DOM.
 *
 * Grammar — a boolean expression with `AND` binding tighter than `OR`, and
 * parentheses for grouping (Phase 48); the leaf terms are the original Phase-47 set:
 *
 *   - `field:value`     → text CONTAINS  (`name:esp32`)
 *   - `field=value`     → EQUALS         (`mpn=ABC-123`, `quantity=3`)
 *   - `field>n` / `<n`  → numeric compare (`quantity>10`)
 *   - `cap:<key>`       → HAS_CAPABILITY (presence)
 *   - `cap:<key>>n`…    → capability compare / EQUALS (numeric or text)
 *   - `field:<name>`    → custom-field CONTAINS (`field:Datasheet:rev2`)
 *   - `field:<name>>n`… → custom-field compare / EQUALS (numeric or text)
 *   - bare word / "phrase" → name CONTAINS
 *   - `a b`             → AND (juxtaposition, or the explicit `AND` keyword)
 *   - `a OR b` / `a|b`  → OR (case-insensitive keyword, or the `|` operator)
 *   - `( … )`           → an explicit nested group (overriding precedence)
 *
 * Field names are case-insensitive and accept short aliases (`desc`, `mfr`, `qty`).
 * Anything that wouldn't translate (a `>` on a text field, a non-numeric quantity,
 * a missing value, an unbalanced parenthesis, a tree nested past the §5.1 depth cap)
 * returns a typed `{ ok: false, error }` so the input can surface the problem and
 * keep the previous good search rather than load a broken tree. To keep that promise
 * end-to-end, a successfully-built tree is finally run through the real
 * {@link parseASTtoSQL} — the single SQL translator — so the text path can never emit
 * an AST it would reject (e.g. an over-deep nest snaps back to an inline error).
 *
 * A bracket or `|` inside a value must be quoted (`name:"a|b"`) — unquoted they are
 * structural, exactly so the grammar is unambiguous.
 */
import {
  emptyAst,
  isGroupNode,
  type ASTGroupNode,
  type FilterCondition,
  type FilterOperator,
  type LogicalOperator,
  type SearchAST,
} from '@/db/search/ast';
import { SearchAstError, parseASTtoSQL } from '@/db/search/parseASTtoSQL';
import { toCapabilityField, toCustomField } from './fields';

export type ParseTextQueryResult =
  | { ok: true; ast: SearchAST }
  | { ok: false; error: string };

/** A parsed sub-expression: a group, a leaf condition, or "matched nothing". */
type Node = ASTGroupNode | FilterCondition | null;

/** A failure raised while parsing the boolean/paren structure (vs a leaf term). */
class TextQueryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TextQueryError';
  }
}

type FieldKind = 'text' | 'numeric';

/**
 * Alias → canonical scalar field. The canonical names mirror the §5.1 `ITEM_FIELDS`
 * the SQL translator accepts (capability is handled separately via the `cap:` form).
 */
const FIELD_ALIASES: Readonly<Record<string, { field: string; kind: FieldKind }>> = {
  name: { field: 'name', kind: 'text' },
  description: { field: 'description', kind: 'text' },
  desc: { field: 'description', kind: 'text' },
  notes: { field: 'notes', kind: 'text' },
  note: { field: 'notes', kind: 'text' },
  mpn: { field: 'mpn', kind: 'text' },
  manufacturer: { field: 'manufacturer', kind: 'text' },
  mfr: { field: 'manufacturer', kind: 'text' },
  make: { field: 'manufacturer', kind: 'text' },
  quantity: { field: 'quantity', kind: 'numeric' },
  qty: { field: 'quantity', kind: 'numeric' },
};

const CAPABILITY_ALIASES = new Set(['cap', 'capability']);

/**
 * Prefixes that introduce a category custom-field term, `field:<name>[op<value>]`
 * (Phase 71). The remainder after the leading `field:`/`cf:` is itself a `<name>` and
 * an optional comparison operator + value, mirroring the `cap:` form. The custom-field
 * *name* may itself contain spaces only when quoted (the whole token is whitespace-
 * delimited by the lexer), so unquoted multi-word names aren't expressible — the
 * Visual Builder's free-text name input covers those.
 */
const CUSTOM_FIELD_ALIASES = new Set(['field', 'cf']);

/** Separator characters that introduce a field term's operator. */
const SEPARATORS = new Set([':', '=', '>', '<']);
const QUOTES = new Set(['"', "'"]);

/** A leaf condition, or a parse failure message for one term. */
type TermResult = { condition: FilterCondition } | { skip: true } | { error: string };

/** A lexical token: the boolean/paren structure, plus opaque leaf `TERM` text. */
type LexToken =
  | { kind: 'TERM'; text: string }
  | { kind: 'OR' }
  | { kind: 'AND' }
  | { kind: 'LPAREN' }
  | { kind: 'RPAREN' };

/**
 * Parse a text query into the Visual-Builder {@link SearchAST}. Lexes into a token
 * stream, parses it by precedence (OR of ANDs of factors, a factor being a bracketed
 * sub-expression or a leaf term), then validates the whole tree through the real SQL
 * translator so the output is guaranteed loadable.
 */
export function parseTextQuery(input: string): ParseTextQueryResult {
  const tokens = lex(input);
  let pos = 0;
  const peek = (): LexToken | undefined => tokens[pos];

  /** `orExpr := andExpr ( OR andExpr )*` — the lowest-precedence level. */
  const parseOrExpr = (): Node => {
    const branches: Node[] = [parseAndExpr()];
    while (peek()?.kind === 'OR') {
      pos++;
      branches.push(parseAndExpr());
    }
    return combine(branches, 'OR');
  };

  /** `andExpr := factor*` — juxtaposition (or an explicit `AND`) means AND. */
  const parseAndExpr = (): Node => {
    const factors: Node[] = [];
    for (;;) {
      const token = peek();
      if (!token || token.kind === 'OR' || token.kind === 'RPAREN') break;
      if (token.kind === 'AND') {
        pos++; // an explicit AND keyword is just a separator
        continue;
      }
      factors.push(parseFactor());
    }
    return combine(factors, 'AND');
  };

  /** `factor := '(' orExpr ')' | TERM`. */
  const parseFactor = (): Node => {
    const token = peek()!; // the caller only enters here on a TERM or LPAREN
    if (token.kind === 'LPAREN') {
      pos++;
      const inner = parseOrExpr();
      if (peek()?.kind !== 'RPAREN') {
        throw new TextQueryError('Unmatched "(" — add a closing ")" (or quote a literal bracket).');
      }
      pos++;
      return inner;
    }
    // The caller only enters parseFactor on a TERM or LPAREN; LPAREN is handled above.
    if (token.kind !== 'TERM') {
      throw new TextQueryError('Unexpected token in the search query.');
    }
    pos++;
    return termToNode(token.text);
  };

  try {
    const node = parseOrExpr();
    if (pos < tokens.length) {
      // The only token that stops parseAndExpr without being consumed is a stray ')'.
      throw new TextQueryError('Unmatched ")" — remove it (or quote a literal bracket).');
    }
    const ast = toRootGroup(node);
    // Final gate: `parseASTtoSQL` is the single SQL translator (§5.1) — running it here
    // guarantees the text path never loads a tree it would reject (e.g. an over-deep nest).
    parseASTtoSQL(ast);
    return { ok: true, ast };
  } catch (err) {
    if (err instanceof TextQueryError || err instanceof SearchAstError) {
      return { ok: false, error: err.message };
    }
    throw err;
  }
}

/**
 * Combine parsed children under one logical operator, dropping the empties (so a
 * blank `()` or a dangling `OR` contributes nothing) and **flattening** a sole child
 * so redundant brackets (`((esp32))`) never inflate the tree's depth.
 */
function combine(children: Node[], operator: LogicalOperator): Node {
  const kept = children.filter((c): c is ASTGroupNode | FilterCondition => c !== null);
  if (kept.length === 0) return null;
  if (kept.length === 1) return kept[0]!;
  return { type: 'GROUP', logicalOperator: operator, conditions: kept };
}

/** The root of a SearchAST is always a GROUP — wrap a bare condition, default empty. */
function toRootGroup(node: Node): ASTGroupNode {
  if (node === null) return emptyAst('AND');
  if (isGroupNode(node)) return node;
  return { ...emptyAst('AND'), conditions: [node] };
}

/** Turn one leaf TERM string into a condition (or skip/throw), reusing the §47 grammar. */
function termToNode(text: string): Node {
  const result = parseTerm(text);
  if ('error' in result) throw new TextQueryError(result.error);
  if ('skip' in result) return null;
  return result.condition;
}

/**
 * Lex the query into structural tokens. Whitespace, `(`, `)` and `|` are token
 * boundaries; a bare `OR`/`AND` word (case-insensitive, unquoted) is a keyword.
 * Quoted spans are kept verbatim so a bracket or `|` inside quotes is literal.
 */
function lex(input: string): LexToken[] {
  const tokens: LexToken[] = [];
  let buffer = '';
  let quote: string | null = null;
  const flush = () => {
    if (buffer.length === 0) return;
    const upper = buffer.toUpperCase();
    if (upper === 'OR') tokens.push({ kind: 'OR' });
    else if (upper === 'AND') tokens.push({ kind: 'AND' });
    else tokens.push({ kind: 'TERM', text: buffer });
    buffer = '';
  };
  for (const ch of input) {
    if (quote) {
      buffer += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (QUOTES.has(ch)) {
      quote = ch;
      buffer += ch;
      continue;
    }
    if (/\s/.test(ch)) {
      flush();
      continue;
    }
    if (ch === '(') {
      flush();
      tokens.push({ kind: 'LPAREN' });
      continue;
    }
    if (ch === ')') {
      flush();
      tokens.push({ kind: 'RPAREN' });
      continue;
    }
    if (ch === '|') {
      flush();
      tokens.push({ kind: 'OR' });
      continue;
    }
    buffer += ch;
  }
  flush();
  return tokens;
}

/** Parse one whitespace-delimited token into a leaf condition (or skip/error). */
function parseTerm(token: string): TermResult {
  // A leading quote means the whole token is a bare phrase, never a field term.
  const sepIndex = QUOTES.has(token[0] ?? '') ? -1 : findSeparator(token);

  if (sepIndex < 0) {
    const value = unquote(token);
    if (value.length === 0) return { skip: true };
    return { condition: { field: 'name', operator: 'CONTAINS', value } };
  }

  const rawField = token.slice(0, sepIndex);
  const sep = token[sepIndex]!;
  const fieldKey = rawField.toLowerCase();
  const rest = token.slice(sepIndex + 1);

  // Capability terms use the `cap:<key>[op<value>]` form (separator is always ':').
  if (CAPABILITY_ALIASES.has(fieldKey) && sep === ':') {
    return parseCapabilityTerm(rest);
  }

  // Custom-field terms use the `field:<name>[op<value>]` form (separator is always ':').
  if (CUSTOM_FIELD_ALIASES.has(fieldKey) && sep === ':') {
    return parseCustomFieldTerm(rest);
  }

  const meta = FIELD_ALIASES[fieldKey];
  // An unknown prefix isn't an error — treat the whole token as a name search, so a
  // pasted URL or a stray colon never blocks the query.
  if (!meta) {
    const value = unquote(token);
    return value.length === 0 ? { skip: true } : { condition: { field: 'name', operator: 'CONTAINS', value } };
  }

  return meta.kind === 'numeric'
    ? parseNumericTerm(meta.field, sep, rest)
    : parseTextTerm(meta.field, sep, rest);
}

function parseTextTerm(field: string, sep: string, rawValue: string): TermResult {
  if (sep === '>' || sep === '<') {
    return { error: `The "${field}" field holds text, so it can't be compared with ${sep}; use ${field}: to match it.` };
  }
  const value = unquote(rawValue);
  if (value.length === 0) return { error: `Search term "${field}${sep}" is missing a value.` };
  const operator: FilterOperator = sep === '=' ? 'EQUALS' : 'CONTAINS';
  return { condition: { field, operator, value } };
}

function parseNumericTerm(field: string, sep: string, rawValue: string): TermResult {
  const value = unquote(rawValue);
  if (value.length === 0) return { error: `Search term "${field}${sep}" is missing a value.` };
  const num = asFiniteNumber(value);
  if (num === null) return { error: `The "${field}" filter needs a number, got "${value}".` };
  const operator: FilterOperator = sep === '>' ? 'GREATER_THAN' : sep === '<' ? 'LESS_THAN' : 'EQUALS';
  return { condition: { field, operator, value: num } };
}

/** Parse the `<key>[op<value>]` remainder after a `cap:` prefix. */
function parseCapabilityTerm(rest: string): TermResult {
  const opIndex = findCapabilityOperator(rest);
  const key = (opIndex < 0 ? rest : rest.slice(0, opIndex)).trim();
  if (key.length === 0) return { error: 'A capability filter needs a key, e.g. cap:voltage.' };

  const field = toCapabilityField(key);
  if (opIndex < 0) {
    return { condition: { field, operator: 'HAS_CAPABILITY', value: '' } };
  }

  const op = rest[opIndex]!;
  const value = unquote(rest.slice(opIndex + 1));
  if (value.length === 0) return { error: `Capability filter "cap:${key}${op}" is missing a value.` };

  if (op === '>' || op === '<') {
    const num = asFiniteNumber(value);
    if (num === null) return { error: `Capability "${key}" needs a number to compare, got "${value}".` };
    return { condition: { field, operator: op === '>' ? 'GREATER_THAN' : 'LESS_THAN', value: num } };
  }

  // `=` — numeric when the value is a number, otherwise an exact text match.
  const num = asFiniteNumber(value);
  return { condition: { field, operator: 'EQUALS', value: num ?? value } };
}

/**
 * Parse the `<name>[op<value>]` remainder after a `field:` prefix (Phase 71).
 *
 * The operator set mirrors a scalar term: `:` → CONTAINS, `=` → EQUALS, `>`/`<` →
 * numeric compare. A bare `field:<name>` (no operator) means "the item carries any
 * value for this field" → HAS_CAPABILITY (reused as the generic presence operator).
 * Resolution by name happens in the SQL layer, so an unknown name is not an error
 * here — it simply matches nothing at query time.
 */
function parseCustomFieldTerm(rest: string): TermResult {
  const opIndex = findCustomFieldOperator(rest);
  const name = (opIndex < 0 ? rest : rest.slice(0, opIndex)).trim();
  if (name.length === 0) return { error: 'A custom-field filter needs a name, e.g. field:Datasheet.' };

  const field = toCustomField(name);
  if (opIndex < 0) {
    return { condition: { field, operator: 'HAS_CAPABILITY', value: '' } };
  }

  const op = rest[opIndex]!;
  const value = unquote(rest.slice(opIndex + 1));
  if (value.length === 0) return { error: `Custom-field filter "field:${name}${op}" is missing a value.` };

  if (op === '>' || op === '<') {
    const num = asFiniteNumber(value);
    if (num === null) return { error: `Custom field "${name}" needs a number to compare, got "${value}".` };
    return { condition: { field, operator: op === '>' ? 'GREATER_THAN' : 'LESS_THAN', value: num } };
  }
  if (op === '=') {
    // Numeric when the value parses as a number, otherwise an exact text match.
    const num = asFiniteNumber(value);
    return { condition: { field, operator: 'EQUALS', value: num ?? value } };
  }
  // `:` — a substring (CONTAINS) match against the stored value.
  return { condition: { field, operator: 'CONTAINS', value } };
}

/** Index of the first comparison/CONTAINS operator in a custom-field remainder. */
function findCustomFieldOperator(rest: string): number {
  for (let i = 0; i < rest.length; i++) {
    const ch = rest[i]!;
    if (QUOTES.has(ch)) return -1;
    if (ch === ':' || ch === '>' || ch === '<' || ch === '=') return i;
  }
  return -1;
}

/** Index of the first top-level separator, or -1 (stops at a quote — see tokenize). */
function findSeparator(token: string): number {
  for (let i = 0; i < token.length; i++) {
    const ch = token[i]!;
    if (QUOTES.has(ch)) return -1;
    if (SEPARATORS.has(ch)) return i;
  }
  return -1;
}

/** Index of the first comparison operator in a capability remainder (`:` is not one). */
function findCapabilityOperator(rest: string): number {
  for (let i = 0; i < rest.length; i++) {
    const ch = rest[i]!;
    if (QUOTES.has(ch)) return -1;
    if (ch === '>' || ch === '<' || ch === '=') return i;
  }
  return -1;
}

/** Strip a single surrounding pair of matching quotes, if present. */
function unquote(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length >= 2 && QUOTES.has(trimmed[0]!) && trimmed[trimmed.length - 1] === trimmed[0]) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

/** Parse a finite number (integer or decimal), or null. */
function asFiniteNumber(value: string): number | null {
  if (value.trim().length === 0) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}
