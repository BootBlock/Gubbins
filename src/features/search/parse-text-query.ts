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
 *   - `field>n` / `<n`  → numeric compare (`quantity>10`, `cost>10` in major currency units)
 *   - `field:yyyy-mm-dd` → a calendar day; `>`/`<` are after/before it (`expiry<2026-03-01`)
 *   - `field:member`    → one of a fixed vocabulary (`condition=needs-repair`)
 *   - `cap:<key>`       → HAS_CAPABILITY (presence)
 *   - `cap:<key>>n`…    → capability compare / EQUALS (numeric or text)
 *   - `field:<name>`    → custom-field CONTAINS (`field:Datasheet:rev2`)
 *   - `field:<name>>n`… → custom-field compare / EQUALS (numeric or text)
 *   - `tag:<name>`      → tag name CONTAINS (`tag=<name>` for the whole name)
 *   - `has:<field>`     → presence — the item carries *any* value for it (`has:mpn`)
 *   - bare word / "phrase" → name CONTAINS
 *   - `a b`             → AND (juxtaposition, or the explicit `AND` keyword)
 *   - `a OR b` / `a|b`  → OR (case-insensitive keyword, or the `|` operator)
 *   - `( … )`           → an explicit nested group (overriding precedence)
 *   - `-a` / `NOT a`    → negation, binding to the single following term or group
 *
 * Negation (issue #139) is the one form that changes the *shape* of the tree rather than a
 * leaf: it lowers to a negated GROUP (see {@link negated}), so `-mfr:acme` is "NOT (the
 * manufacturer contains acme)" and `-(a OR b)` negates the whole bracket. That is also how
 * "not equal to" is written — `-mpn=ABC-123` — rather than adding a separate `!=` operator.
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
 * structural, exactly so the grammar is unambiguous. The same applies to a leading `-`:
 * it negates, so a term that genuinely starts with one must be quoted (`"-40C"`).
 */
import {
  emptyAst,
  isGroupNode,
  negated,
  type ASTGroupNode,
  type FilterCondition,
  type FilterOperator,
  type LogicalOperator,
  type SearchAST,
} from '@/db/search/ast';
import { SearchAstError, parseASTtoSQL, parseBooleanValue, parseEnumValue } from '@/db/search/parseASTtoSQL';
import { toCapabilityField, toCustomField } from './fields';

export type ParseTextQueryResult = { ok: true; ast: SearchAST } | { ok: false; error: string };

/** A parsed sub-expression: a group, a leaf condition, or "matched nothing". */
type Node = ASTGroupNode | FilterCondition | null;

/** A failure raised while parsing the boolean/paren structure (vs a leaf term). */
class TextQueryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TextQueryError';
  }
}

/**
 * How a term's value is read before it becomes a condition. `text`, `numeric` and `boolean`
 * are the original Phase-47 forms; `date`, `money` and `enum` (issue #140) differ only in
 * which operators they accept and how a bad value is reported here — the *canonical* value
 * and every validation that matters still belong to `parseASTtoSQL`, which this file's final
 * gate re-runs, so the two layers can't disagree about what a field accepts.
 */
type FieldKind = 'text' | 'numeric' | 'boolean' | 'date' | 'money' | 'enum';

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
  barcode: { field: 'barcode', kind: 'text' },
  gtin: { field: 'barcode', kind: 'text' },
  upc: { field: 'barcode', kind: 'text' },
  ean: { field: 'barcode', kind: 'text' },
  serial: { field: 'serial', kind: 'text' },
  serialnumber: { field: 'serial', kind: 'text' },
  sn: { field: 'serial', kind: 'text' },
  quantity: { field: 'quantity', kind: 'numeric' },
  qty: { field: 'quantity', kind: 'numeric' },
  // Intrinsic weight in canonical grams (issue #25), e.g. `weight>500` for over 500 g.
  weight: { field: 'weight', kind: 'numeric' },
  // Intrinsic bounding-box dimensions in canonical millimetres (issue #30), e.g. `width>100`.
  width: { field: 'width', kind: 'numeric' },
  height: { field: 'height', kind: 'numeric' },
  depth: { field: 'depth', kind: 'numeric' },
  // "Favourite" pin (issue #23) — a yes/no flag, e.g. `favourite:yes` (US spelling `favorite:`
  // and the short `fav:` both accepted).
  favourite: { field: 'favourite', kind: 'boolean' },
  favorite: { field: 'favourite', kind: 'boolean' },
  fav: { field: 'favourite', kind: 'boolean' },
  // Tags (issue #138) — the value is a tag *name*, so `tag:expo` matches any tag containing
  // "expo" and `tag=fragile` only the tag named exactly "fragile" (both case-insensitive).
  // The plural reads naturally when a query names one of several tags an item carries.
  tag: { field: 'tag', kind: 'text' },
  tags: { field: 'tag', kind: 'text' },
  tagged: { field: 'tag', kind: 'text' },
  // --- Lifecycle, valuation & stock policy (issue #140) -------------------------
  // Fixed-vocabulary enums, e.g. `condition=needs-repair`, `tracking=serialised`.
  condition: { field: 'condition', kind: 'enum' },
  cond: { field: 'condition', kind: 'enum' },
  tracking: { field: 'tracking', kind: 'enum' },
  trackingmode: { field: 'tracking', kind: 'enum' },
  deadstock: { field: 'deadstock', kind: 'enum' },
  // Calendar days as `YYYY-MM-DD`, e.g. `expiry<2026-03-01` for "expiring before March".
  expiry: { field: 'expiry', kind: 'date' },
  expires: { field: 'expiry', kind: 'date' },
  expirydate: { field: 'expiry', kind: 'date' },
  warranty: { field: 'warranty', kind: 'date' },
  warrantyexpires: { field: 'warranty', kind: 'date' },
  // Money, typed in the base currency's major units (`cost>10` is ten, not ten micro-units).
  cost: { field: 'cost', kind: 'money' },
  unitcost: { field: 'cost', kind: 'money' },
  price: { field: 'price', kind: 'money' },
  purchaseprice: { field: 'price', kind: 'money' },
  paid: { field: 'price', kind: 'money' },
  value: { field: 'value', kind: 'money' },
  currentvalue: { field: 'value', kind: 'money' },
  worth: { field: 'value', kind: 'money' },
  // The item's own low-stock floor, e.g. `reorder>0` for items carrying one at all.
  reorder: { field: 'reorder', kind: 'numeric' },
  reorderpoint: { field: 'reorder', kind: 'numeric' },
  // Soft-deletion flag — `active:no` finds decommissioned items, which the search path's
  // usual "active inventory only" scope steps aside for.
  active: { field: 'active', kind: 'boolean' },
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

/** Prefixes that introduce a presence term, `has:<field>` (issue #139). */
const PRESENCE_ALIASES = new Set(['has', 'have']);

/**
 * Alias → canonical field for `has:<field>`, restricted to the columns an item can genuinely
 * be *missing* (issue #139). Absence is the whole point of the form, so a `NOT NULL` column
 * has no business here: `has:name` would match every item, and its negation none.
 *
 * `category` appears only in this table, not in {@link FIELD_ALIASES}: the column holds an id,
 * so `category:kitchen` has nothing sensible to compare against and is left to fall through to
 * a plain name search — but "has a category at all" needs no id, so presence works fine.
 */
const PRESENCE_FIELDS: Readonly<Record<string, string>> = {
  description: 'description',
  desc: 'description',
  notes: 'notes',
  note: 'notes',
  mpn: 'mpn',
  manufacturer: 'manufacturer',
  mfr: 'manufacturer',
  make: 'manufacturer',
  barcode: 'barcode',
  gtin: 'barcode',
  upc: 'barcode',
  ean: 'barcode',
  serial: 'serial',
  serialnumber: 'serial',
  sn: 'serial',
  weight: 'weight',
  width: 'width',
  height: 'height',
  depth: 'depth',
  category: 'category',
};

/**
 * Fields every item always carries, mapped to how to say so. Asking `has:` about one is
 * always-true (and its negation always-false), which is far more likely a misunderstanding
 * than an intent — so it is named as such rather than silently answered.
 */
const ALWAYS_PRESENT_FIELDS: Readonly<Record<string, string>> = {
  name: 'name',
  quantity: 'quantity',
  qty: 'quantity',
  location: 'location',
  favourite: 'favourite flag',
  favorite: 'favourite flag',
  fav: 'favourite flag',
};

/** Separator characters that introduce a field term's operator. */
const SEPARATORS = new Set([':', '=', '>', '<']);
const QUOTES = new Set(['"', "'"]);

/**
 * True when a quote at `index` sits where a quoted span could *begin* — at the start of a
 * term, or immediately after a field separator. Anywhere else it is an ordinary character,
 * so an English possessive or contraction (`Bob's`, `don't`, `O'Reilly`) and an inch mark
 * (`3.5"`) stay literal instead of swallowing every term after them (issue #625), while
 * `name:"a b"` and `"-40C"` are unaffected.
 *
 * Position alone is not enough — see {@link hasClosingQuote}, which the lexer also requires.
 *
 * `index` is where the quote *sits*, which the lexer gives as the current buffer length —
 * it has not appended the quote yet — so only the character before it is ever read.
 */
function opensQuotedSpan(text: string, index: number): boolean {
  if (index === 0) return true;
  return SEPARATORS.has(text[index - 1]!);
}

/**
 * True when a quote at `index` could *close* a span — it ends a token, so what follows is a
 * token boundary or nothing at all. A quote inside a word never closes one, which is what
 * stops a later contraction acting as the partner for an elided leading apostrophe: in
 * `'80s vinyl tag:retro don't`, the `'` in `don't` is not a candidate, so the leading one
 * opens nothing and every filter survives (issue #625).
 */
function closesQuotedSpan(chars: readonly string[], index: number): boolean {
  const next = chars[index + 1];
  if (next === undefined) return true;
  return /\s/.test(next) || next === '(' || next === ')' || next === '|';
}

/** True when some quote after `from` could close a span opened there. */
function hasClosingQuote(chars: readonly string[], from: number, quote: string): boolean {
  for (let i = from + 1; i < chars.length; i++) {
    if (chars[i] === quote && closesQuotedSpan(chars, i)) return true;
  }
  return false;
}

/** A leaf condition, or a parse failure message for one term. */
type TermResult = { condition: FilterCondition } | { skip: true } | { error: string };

/** A lexical token: the boolean/paren structure, plus opaque leaf `TERM` text. */
type LexToken =
  | { kind: 'TERM'; text: string }
  | { kind: 'OR' }
  | { kind: 'AND' }
  | { kind: 'NOT' }
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

  /** `factor := ('NOT' | '-') factor | '(' orExpr ')' | TERM`. */
  const parseFactor = (): Node => {
    const token = peek()!; // the caller only enters here on a TERM, NOT or LPAREN
    if (token.kind === 'NOT') {
      pos++;
      const next = peek();
      if (!next || next.kind === 'OR' || next.kind === 'AND' || next.kind === 'RPAREN') {
        throw new TextQueryError('"NOT" needs a term to negate — e.g. NOT mfr:acme (or -mfr:acme).');
      }
      // Negation binds to one factor, so `-a b` is "(not a) and b", not "not (a and b)".
      const inner = parseFactor();
      return inner === null ? null : negated(inner);
    }
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
 * True when a query carries no search *syntax* at all — every token is a bare, unquoted
 * word with no `field:value` separator — so it means exactly the same thing typed into the
 * plain quick-search box (issue #136). Recalling such a saved search fills that box rather
 * than opening the Visual Builder; see `planSavedSearchRecall`.
 *
 * Decided by the grammar's own lexer rather than a second hand-rolled scan, so it can never
 * drift from what {@link parseTextQuery} treats as structure: a boolean keyword, a bracket,
 * a leading `-`, a quoted phrase or any separator all make it a *builder* query. A blank
 * query is not plain — there is nothing to put in the box.
 */
export function isPlainTextQuery(input: string): boolean {
  const tokens = lex(input);
  if (tokens.length === 0) return false;
  return tokens.every(
    (token) => token.kind === 'TERM' && !QUOTES.has(token.text[0] ?? '') && findSeparator(token.text) < 0,
  );
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
 * boundaries; a bare `OR`/`AND`/`NOT` word (case-insensitive, unquoted) is a keyword.
 * Quoted spans are kept verbatim so a bracket or `|` inside quotes is literal — but only a
 * quote that could open one *and* has a later quote able to close it starts a span (#625).
 *
 * A `-` is the shorthand `NOT` **only where a term could start** — buffer empty, outside
 * quotes, and immediately followed by something to negate. Everywhere else it stays an
 * ordinary character, which is what keeps `mpn:ABC-123`, `qty>-1` and a trailing `-`
 * lexing exactly as they did before negation existed (issue #139).
 */
function lex(input: string): LexToken[] {
  const tokens: LexToken[] = [];
  const chars = [...input];
  let buffer = '';
  let quote: string | null = null;
  const flush = () => {
    if (buffer.length === 0) return;
    const upper = buffer.toUpperCase();
    if (upper === 'OR') tokens.push({ kind: 'OR' });
    else if (upper === 'AND') tokens.push({ kind: 'AND' });
    else if (upper === 'NOT') tokens.push({ kind: 'NOT' });
    else tokens.push({ kind: 'TERM', text: buffer });
    buffer = '';
  };
  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i]!;
    if (quote) {
      buffer += ch;
      if (ch === quote && closesQuotedSpan(chars, i)) quote = null;
      continue;
    }
    // A quote is structure only where a phrase could begin *and* where a later quote could
    // end it. Both halves are needed: without the first, `Bob's` swallows the query; without
    // the second, an elided leading apostrophe (`'80s`, `'til`) opens a span that runs to the
    // end. A quote failing either test is an ordinary character. `hasClosingQuote` uses the
    // same test the branch above closes on, so `quote` is always null once the loop finishes.
    if (QUOTES.has(ch) && opensQuotedSpan(buffer, buffer.length) && hasClosingQuote(chars, i, ch)) {
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
    if (ch === '-' && buffer.length === 0 && startsANegatableTerm(chars[i + 1])) {
      tokens.push({ kind: 'NOT' });
      continue;
    }
    buffer += ch;
  }
  flush();
  return tokens;
}

/** True when the character after a leading `-` could begin a term or bracket to negate. */
function startsANegatableTerm(next: string | undefined): boolean {
  return next !== undefined && !/\s/.test(next) && next !== ')' && next !== '|';
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

  // Presence terms use the `has:<field>` form (separator is always ':').
  if (PRESENCE_ALIASES.has(fieldKey) && sep === ':') {
    return parsePresenceTerm(rest);
  }

  // `Object.hasOwn`, never a bare index: a plain object also answers to its prototype's keys, so
  // `FIELD_ALIASES['constructor']` would yield a *function* — a truthy non-alias with no `kind`,
  // which falls out of the switch below with nothing returned. Typing `constructor:foo` in the
  // search box is a name search, not a crash.
  const meta = Object.hasOwn(FIELD_ALIASES, fieldKey) ? FIELD_ALIASES[fieldKey] : undefined;
  // An unknown prefix isn't an error — treat the whole token as a name search, so a
  // pasted URL or a stray colon never blocks the query.
  if (!meta) {
    const value = unquote(token);
    return value.length === 0
      ? { skip: true }
      : { condition: { field: 'name', operator: 'CONTAINS', value } };
  }

  switch (meta.kind) {
    case 'boolean':
      return parseBooleanTerm(meta.field, sep, rest);
    case 'numeric':
    case 'money':
      // Both read a plain number; `money` is in major units, scaled to the stored micro-units
      // by the SQL translator (issue #286) rather than here.
      return parseNumericTerm(meta.field, sep, rest);
    case 'date':
      return parseDateTerm(meta.field, sep, rest);
    case 'enum':
      return parseEnumTerm(meta.field, sep, rest);
    case 'text':
      return parseTextTerm(meta.field, sep, rest);
  }
}

function parseBooleanTerm(field: string, sep: string, rawValue: string): TermResult {
  if (sep === '>' || sep === '<') {
    return {
      error: `The "${field}" field is yes/no, so it can't be compared with ${sep}; use ${field}:yes or ${field}:no.`,
    };
  }
  const value = unquote(rawValue);
  if (value.length === 0) {
    return { error: `Search term "${field}${sep}" is missing a value (try ${field}:yes).` };
  }
  // Canonicalise through the shared yes/no vocabulary the SQL layer coerces with (no drift).
  const parsed = parseBooleanValue(value);
  if (parsed === null) return { error: `The "${field}" filter needs yes or no, got "${value}".` };
  return { condition: { field, operator: 'EQUALS', value: parsed } };
}

function parseTextTerm(field: string, sep: string, rawValue: string): TermResult {
  if (sep === '>' || sep === '<') {
    return {
      error: `The "${field}" field holds text, so it can't be compared with ${sep}; use ${field}: to match it.`,
    };
  }
  const value = unquote(rawValue);
  if (value.length === 0) return { error: `Search term "${field}${sep}" is missing a value.` };
  const operator: FilterOperator = sep === '=' ? 'EQUALS' : 'CONTAINS';
  return { condition: { field, operator, value } };
}

/**
 * Parse a calendar-day term (issue #140), e.g. `expiry<2026-03-01`. `:` reads as "on that day"
 * (EQUALS) — the same "obvious" reading `mfr:acme` has — while `>`/`<` are after/before it.
 * The day itself is validated by the SQL translator, the single owner of the date form.
 */
function parseDateTerm(field: string, sep: string, rawValue: string): TermResult {
  const value = unquote(rawValue);
  if (value.length === 0) {
    return { error: `Search term "${field}${sep}" is missing a date (try ${field}:2026-03-01).` };
  }
  const operator: FilterOperator = sep === '>' ? 'GREATER_THAN' : sep === '<' ? 'LESS_THAN' : 'EQUALS';
  return { condition: { field, operator, value } };
}

/**
 * Parse a fixed-vocabulary term (issue #140), e.g. `condition=needs-repair`. Both `:` and `=`
 * mean EQUALS — an enum has nothing to substring-match — and ordering comparisons are rejected
 * here, where the field name is still to hand for the message. The accepted spellings are the
 * SQL translator's business, so an unrecognised value falls through to its error, which names
 * the whole vocabulary.
 */
function parseEnumTerm(field: string, sep: string, rawValue: string): TermResult {
  if (sep === '>' || sep === '<') {
    return {
      error: `The "${field}" field is a fixed set of values, so it can't be compared with ${sep}; use ${field}: to match one.`,
    };
  }
  const value = unquote(rawValue);
  if (value.length === 0) return { error: `Search term "${field}${sep}" is missing a value.` };
  // Canonicalise to the stored spelling through the SQL layer's own vocabulary, so the tree this
  // loads into the Visual Builder already matches that field's picker. An unrecognised value
  // passes through untouched for the final gate to reject, naming the whole vocabulary.
  return { condition: { field, operator: 'EQUALS', value: parseEnumValue(field, value) ?? value } };
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

/**
 * Parse the `<field>` remainder after a `has:` prefix — "the item carries any value for
 * this" (issue #139). Pairs with negation to ask the question that actually gets asked:
 * `-has:category` is "anything without a category", `-has:Datasheet` "no datasheet".
 *
 * A name that isn't one of the {@link PRESENCE_FIELDS} columns is read as a category
 * **custom field**, since those are the fields a user names themselves. Resolution happens
 * in the SQL layer, so an unknown name is not an error here — it simply matches nothing.
 */
function parsePresenceTerm(rest: string): TermResult {
  const name = unquote(rest);
  if (name.length === 0) {
    return { error: 'A presence filter needs a field, e.g. has:mpn or has:Datasheet.' };
  }

  // `Object.hasOwn`, never a bare index — same reason as the field-alias lookup above:
  // `ALWAYS_PRESENT_FIELDS['constructor']` would otherwise be a truthy *function*, so
  // `has:constructor` would report "every item has a function () { … }" instead of reading as
  // the name of one of your own custom fields.
  const key = name.toLowerCase();
  if (Object.hasOwn(ALWAYS_PRESENT_FIELDS, key)) {
    const label = ALWAYS_PRESENT_FIELDS[key];
    return { error: `Every item has a ${label}, so "has:${name}" would match everything.` };
  }

  const scalar = Object.hasOwn(PRESENCE_FIELDS, key) ? PRESENCE_FIELDS[key] : undefined;
  const field = scalar ?? toCustomField(name);
  return { condition: { field, operator: 'HAS_CAPABILITY', value: '' } };
}

/** Index of the first comparison/CONTAINS operator in a custom-field remainder. */
function findCustomFieldOperator(rest: string): number {
  for (let i = 0; i < rest.length; i++) {
    const ch = rest[i]!;
    if (QUOTES.has(ch) && opensQuotedSpan(rest, i)) return -1;
    if (ch === ':' || ch === '>' || ch === '<' || ch === '=') return i;
  }
  return -1;
}

/** Index of the first top-level separator, or -1 (stops at a quote — see tokenize). */
function findSeparator(token: string): number {
  for (let i = 0; i < token.length; i++) {
    const ch = token[i]!;
    if (QUOTES.has(ch) && opensQuotedSpan(token, i)) return -1;
    if (SEPARATORS.has(ch)) return i;
  }
  return -1;
}

/** Index of the first comparison operator in a capability remainder (`:` is not one). */
function findCapabilityOperator(rest: string): number {
  for (let i = 0; i < rest.length; i++) {
    const ch = rest[i]!;
    if (QUOTES.has(ch) && opensQuotedSpan(rest, i)) return -1;
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
