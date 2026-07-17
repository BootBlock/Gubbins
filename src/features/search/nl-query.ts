/**
 * Rule-based, no-LLM **natural-language → SearchAST** layer (feature-gap G5).
 *
 * Lets a user type a plain-English phrase — "low stock screws in the garage",
 * "resistors with more than 100 in stock", "out of stock in the shed" — and have it
 * resolve **without** learning the power-user `field:value` / `qty>10` / `cap:key>3.3`
 * syntax. It recognises a small, fixed lexicon of intents and lowers them to the
 * **exact** §5.1 {@link SearchAST} the Visual Builder edits and {@link parseASTtoSQL}
 * translates — so, exactly like {@link parseTextQuery}, an "ask in plain English" box
 * merely *loads* the builder. Pure and exhaustively unit-tested over the AST it emits:
 * no React, no DOM, no SQL is ever hand-built here.
 *
 * **Scope — what maps to the AST.** The AST filters on item *columns* only, so this
 * layer covers the intents that are genuine column predicates:
 *
 *   - **Stock level** — "out of stock" / "none left" → `quantity = 0`; "low stock" /
 *     "running low" → `quantity < N` (N is the caller's low-stock quantity threshold,
 *     falling back to {@link NL_LOW_STOCK_FALLBACK_QTY} when that is off/zero); "in
 *     stock" / "available" → `quantity > 0`.
 *   - **Quantity comparisons** — "more than 10" → `quantity > 10`; "fewer than 5" →
 *     `quantity < 5`; "at least 10" / "10 or more" → `quantity ≥ 10`; "exactly 3" /
 *     "3 in stock" → `quantity = 3`; digit or spelled-out numbers.
 *   - **Location phrases** — "in the garage", "on shelf 2" → `location = <id>`, the
 *     phrase resolved against the caller-supplied location names (longest match wins).
 *   - **Category mentions** — a category name appearing in the phrase → `category = <id>`.
 *   - **Residual words** — whatever is left, minus filler words → a **multi-field** text
 *     match: each leftover keyword is searched across the item's name, description,
 *     manufacturer and notes (OR), and the keywords are ANDed, so a vaguer phrase whose words
 *     live in the *description* or *notes* rather than the *name* still surfaces the item. Each keyword
 *     is singularised and expanded with British/American spelling variants first, so
 *     "batteries" / "grey" also find "battery" / "gray".
 *
 * The **time/loan attention statuses** (expiring, warranty, on-loan, overdue,
 * maintenance-due) are deliberately *out of scope* here: they are not item-column
 * predicates — they need a runtime clock, tunable windows and correlated joins that
 * the context-free {@link parseASTtoSQL} can't express — so forcing them into the AST
 * would mean hand-building SQL, which the hard rule forbids. They remain reachable via
 * the inventory status-filter chips.
 */
import { emptyAst, type ASTGroupNode, type FilterCondition, type SearchAST } from '@/db/search/ast';
import { parseASTtoSQL } from '@/db/search/parseASTtoSQL';

/** A location the phrase may name, resolved to its id when matched. */
export interface NlLocation {
  readonly id: string;
  readonly name: string;
}

/** A category the phrase may name, resolved to its id when matched. */
export interface NlCategory {
  readonly id: string;
  readonly name: string;
}

/** The resolver data + tuning a phrase is interpreted against (all plain data). */
export interface NlContext {
  /** Known locations, so "in the garage" resolves to a `location = <id>` condition. */
  readonly locations?: readonly NlLocation[];
  /** Known categories, so a category name resolves to a `category = <id>` condition. */
  readonly categories?: readonly NlCategory[];
  /**
   * The user's low-stock quantity threshold (Phase 46 preference). "Low stock" lowers
   * to `quantity < threshold`; when the preference is off (`≤ 0`) the friendly
   * {@link NL_LOW_STOCK_FALLBACK_QTY} floor is used so the phrase still means something.
   */
  readonly lowStockQtyThreshold?: number;
}

/** The kind of intent a recognised fragment represents (drives its UI chip's wording). */
export type NlPartKind = 'stock' | 'quantity' | 'location' | 'category' | 'text';

/** One human-readable fragment of what was understood, for echoing back in the UI. */
export interface NlRecognisedPart {
  readonly kind: NlPartKind;
  /** A short British-English label, e.g. "Low stock (under 5)", "In Garage". */
  readonly label: string;
}

/** The result of interpreting a phrase. */
export interface NlInterpretation {
  /** The §5.1 SearchAST — the sole, SQL-bound output (loadable straight into the builder). */
  readonly ast: SearchAST;
  /** What was recognised, in AST order, for an at-a-glance echo of the interpretation. */
  readonly recognised: readonly NlRecognisedPart[];
  /** True when nothing at all was recognised (the AST is the empty "match everything" tree). */
  readonly empty: boolean;
}

/**
 * The quantity floor "low stock" means when the caller's low-stock preference is off
 * (`≤ 0`, the shipped default). A friendly non-zero value so "low stock" is never a
 * `quantity < 0` that matches nothing.
 */
export const NL_LOW_STOCK_FALLBACK_QTY = 5;

/** Filler words dropped from the residual free-text search (they carry no query intent). */
const FILLER_WORDS = new Set([
  'a',
  'an',
  'the',
  'all',
  'any',
  'some',
  'my',
  'me',
  'please',
  'show',
  'find',
  'list',
  'get',
  'give',
  'search',
  'items',
  'item',
  'stuff',
  'things',
  'thing',
  'that',
  'which',
  'are',
  'is',
  'with',
  'and',
  'of',
  'for',
  'to',
  'have',
  'having',
  'containing',
  'contains',
  "what's",
  'whats',
  'where',
  'whereis',
]);

/** Prepositions that introduce a location phrase ("in the garage", "on shelf 2"). */
const LOCATION_PREPOSITIONS = new Set(['in', 'at', 'on', 'inside', 'within', 'from']);

/** Determiners skipped between a location preposition and the location name. */
const LOCATION_DETERMINERS = new Set(['the', 'my', 'a', 'our']);

/**
 * The item text columns a residual keyword is matched against — broadened from the old
 * name-only search so plain-English words that live in an item's description, manufacturer
 * or free-text notes surface it too. All four are FTS-scoped-searchable columns (in
 * `FTS_ITEM_COLUMNS`) that {@link parseASTtoSQL} accepts a column-scoped `CONTAINS` against.
 */
const TEXT_SEARCH_FIELDS = ['name', 'description', 'manufacturer', 'notes'] as const;

/**
 * A small, high-confidence set of British/American spelling variants (plus adapter/adaptor),
 * expanded bidirectionally so a residual keyword also searches its alternate spelling. Kept
 * deliberately narrow — genuine spelling equivalences only, never loose semantic synonyms —
 * so recall broadens without pulling in unrelated items.
 */
const SPELLING_VARIANTS: Readonly<Record<string, readonly string[]>> = {
  grey: ['gray'],
  gray: ['grey'],
  colour: ['color'],
  color: ['colour'],
  aluminium: ['aluminum'],
  aluminum: ['aluminium'],
  fibre: ['fiber'],
  fiber: ['fibre'],
  tyre: ['tire'],
  tire: ['tyre'],
  litre: ['liter'],
  liter: ['litre'],
  metre: ['meter'],
  meter: ['metre'],
  adapter: ['adaptor'],
  adaptor: ['adapter'],
};

/** Spelled-out small numbers, so "more than ten" works alongside "more than 10". */
const NUMBER_WORDS: Readonly<Record<string, number>> = {
  zero: 0,
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
  thirteen: 13,
  fourteen: 14,
  fifteen: 15,
  sixteen: 16,
  seventeen: 17,
  eighteen: 18,
  nineteen: 19,
  twenty: 20,
  thirty: 30,
  forty: 40,
  fifty: 50,
  sixty: 60,
  seventy: 70,
  eighty: 80,
  ninety: 90,
  hundred: 100,
};

/** A single stock-level phrase and the quantity condition it means. */
interface StockPhrase {
  /** The phrase's tokens (already lower-cased), matched as a contiguous run. */
  readonly tokens: readonly string[];
  readonly build: (threshold: number) => { condition: FilterCondition; label: string };
}

/**
 * Stock-level phrases, **longest first** so "out of stock" wins over a bare "stock".
 * "Low stock" reads the caller's threshold; the others are threshold-independent.
 */
const STOCK_PHRASES: readonly StockPhrase[] = [
  ...['out of stock', 'none in stock', 'none left', 'nothing left', 'sold out', 'no stock'].map(
    (p): StockPhrase => ({
      tokens: p.split(' '),
      build: () => ({
        condition: { field: 'quantity', operator: 'EQUALS', value: 0 },
        label: 'Out of stock',
      }),
    }),
  ),
  ...['low on stock', 'running low', 'getting low', 'nearly out', 'almost out', 'low stock', 'low on'].map(
    (p): StockPhrase => ({
      tokens: p.split(' '),
      build: (threshold) => ({
        condition: { field: 'quantity', operator: 'LESS_THAN', value: threshold },
        label: `Low stock (under ${threshold})`,
      }),
    }),
  ),
  ...['in stock', 'on hand', 'in-stock', 'available', 'any left'].map((p): StockPhrase => ({
    tokens: p.split(' '),
    build: () => ({
      condition: { field: 'quantity', operator: 'GREATER_THAN', value: 0 },
      label: 'In stock',
    }),
  })),
];

/** A quantity-comparison operator phrase, mapped to its effect on a following number. */
interface ComparePhrase {
  readonly tokens: readonly string[];
  /** Build the condition from the parsed number (some forms shift it, e.g. "at least"). */
  readonly build: (n: number) => { condition: FilterCondition; label: string };
}

const GREATER = (n: number): FilterCondition => ({ field: 'quantity', operator: 'GREATER_THAN', value: n });
const LESS = (n: number): FilterCondition => ({ field: 'quantity', operator: 'LESS_THAN', value: n });
const EQUAL = (n: number): FilterCondition => ({ field: 'quantity', operator: 'EQUALS', value: n });

/**
 * Comparison phrases that **precede** a number ("more than 10"). Longest first so
 * "greater than or equal to" beats "greater than". "At least"/"at most" and the
 * "or equal" forms are inclusive: on the integer quantities this filters, `≥ n`
 * is `> n-1` and `≤ n` is `< n+1`, so they lower to the strict operators the AST has.
 */
const BEFORE_NUMBER: readonly ComparePhrase[] = [
  {
    tokens: ['greater', 'than', 'or', 'equal', 'to'],
    build: (n) => ({ condition: GREATER(n - 1), label: `Quantity at least ${n}` }),
  },
  { tokens: ['at', 'least'], build: (n) => ({ condition: GREATER(n - 1), label: `Quantity at least ${n}` }) },
  {
    tokens: ['no', 'fewer', 'than'],
    build: (n) => ({ condition: GREATER(n - 1), label: `Quantity at least ${n}` }),
  },
  {
    tokens: ['no', 'less', 'than'],
    build: (n) => ({ condition: GREATER(n - 1), label: `Quantity at least ${n}` }),
  },
  {
    tokens: ['less', 'than', 'or', 'equal', 'to'],
    build: (n) => ({ condition: LESS(n + 1), label: `Quantity at most ${n}` }),
  },
  { tokens: ['at', 'most'], build: (n) => ({ condition: LESS(n + 1), label: `Quantity at most ${n}` }) },
  {
    tokens: ['no', 'more', 'than'],
    build: (n) => ({ condition: LESS(n + 1), label: `Quantity at most ${n}` }),
  },
  { tokens: ['more', 'than'], build: (n) => ({ condition: GREATER(n), label: `Quantity over ${n}` }) },
  { tokens: ['greater', 'than'], build: (n) => ({ condition: GREATER(n), label: `Quantity over ${n}` }) },
  { tokens: ['fewer', 'than'], build: (n) => ({ condition: LESS(n), label: `Quantity under ${n}` }) },
  { tokens: ['less', 'than'], build: (n) => ({ condition: LESS(n), label: `Quantity under ${n}` }) },
  { tokens: ['over'], build: (n) => ({ condition: GREATER(n), label: `Quantity over ${n}` }) },
  { tokens: ['above'], build: (n) => ({ condition: GREATER(n), label: `Quantity over ${n}` }) },
  { tokens: ['under'], build: (n) => ({ condition: LESS(n), label: `Quantity under ${n}` }) },
  { tokens: ['below'], build: (n) => ({ condition: LESS(n), label: `Quantity under ${n}` }) },
  { tokens: ['exactly'], build: (n) => ({ condition: EQUAL(n), label: `Quantity is ${n}` }) },
  { tokens: ['equal', 'to'], build: (n) => ({ condition: EQUAL(n), label: `Quantity is ${n}` }) },
];

/**
 * Comparison phrases that **follow** a number ("10 or more", "5 in stock"). Longest
 * first. "N in stock" (exact count) is matched here so it isn't mistaken for the bare
 * "in stock" (`quantity > 0`) stock-level phrase.
 */
const AFTER_NUMBER: readonly ComparePhrase[] = [
  { tokens: ['or', 'more'], build: (n) => ({ condition: GREATER(n - 1), label: `Quantity at least ${n}` }) },
  { tokens: ['or', 'fewer'], build: (n) => ({ condition: LESS(n + 1), label: `Quantity at most ${n}` }) },
  { tokens: ['or', 'less'], build: (n) => ({ condition: LESS(n + 1), label: `Quantity at most ${n}` }) },
  { tokens: ['in', 'stock'], build: (n) => ({ condition: EQUAL(n), label: `Quantity is ${n}` }) },
  { tokens: ['left'], build: (n) => ({ condition: EQUAL(n), label: `Quantity is ${n}` }) },
];

/**
 * Phrases that merely *name the quantity metric* after a comparison ("more than 100 **in
 * stock**") — redundant restatements, consumed (but not turned into a second condition)
 * so they don't reappear as a bare "in stock" `quantity > 0` or leak into the text search.
 */
const METRIC_SUFFIXES: readonly (readonly string[])[] = [
  ['in', 'stock'],
  ['on', 'hand'],
  ['left'],
  ['remaining'],
  ['available'],
];

/**
 * Interpret a plain-English `phrase` into a {@link SearchAST}. Deterministic and pure;
 * the returned AST is validated through {@link parseASTtoSQL} (the single SQL translator)
 * so a caller can load it into the builder without a further check.
 */
export function interpretNaturalLanguage(phrase: string, context: NlContext = {}): NlInterpretation {
  const tokens = tokenise(phrase);
  const consumed = tokens.map(() => false);
  const threshold = resolveLowStockThreshold(context.lowStockQtyThreshold);

  // Ordered nodes + their echo labels. Matchers run in a fixed priority so the numeric
  // forms ("5 in stock") claim their tokens before the bare stock-level phrases.
  const parts: PartSink = [];

  matchQuantityComparisons(tokens, consumed, parts);
  matchStockLevels(tokens, consumed, parts, threshold);
  matchLocations(tokens, consumed, parts, context.locations ?? []);
  matchCategories(tokens, consumed, parts, context.categories ?? []);

  const textPart = residualText(tokens, consumed);
  if (textPart) parts.push(textPart);

  const conditions = parts.map((p) => p.node);
  const ast: SearchAST =
    conditions.length === 0 ? emptyAst('AND') : { type: 'GROUP', logicalOperator: 'AND', conditions };

  // Final gate: guarantee the tree the SQL translator accepts (mirrors parseTextQuery).
  // Every condition here is constructed valid, so this never throws — but keep the promise
  // explicit so a future matcher change can't silently emit an untranslatable tree.
  const safeAst = isTranslatable(ast) ? ast : emptyAst('AND');

  return {
    ast: safeAst,
    recognised: parts.map((p) => ({ kind: p.kind, label: p.label })),
    empty: conditions.length === 0,
  };
}

/** Split a phrase into lower-cased word tokens (punctuation stripped, numbers kept). */
function tokenise(phrase: string): string[] {
  return phrase
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, ' ')
    .split(/\s+/)
    .filter((t) => t.length > 0);
}

/** The effective "low stock" quantity floor, falling back when the preference is off. */
function resolveLowStockThreshold(pref: number | undefined): number {
  return pref !== undefined && Number.isFinite(pref) && pref > 0
    ? Math.floor(pref)
    : NL_LOW_STOCK_FALLBACK_QTY;
}

/** A recognised part contributes either a leaf condition or a whole AST sub-tree (the text match). */
type PartNode = ASTGroupNode | FilterCondition;
type PartSink = Array<{ kind: NlPartKind; node: PartNode; label: string }>;

/** True when tokens `i..i+phrase.length` are all unconsumed and equal `phrase`. */
function phraseAt(
  tokens: readonly string[],
  consumed: readonly boolean[],
  i: number,
  phrase: readonly string[],
): boolean {
  if (i + phrase.length > tokens.length) return false;
  for (let k = 0; k < phrase.length; k++) {
    if (consumed[i + k] || tokens[i + k] !== phrase[k]) return false;
  }
  return true;
}

/** Mark tokens `[start, end)` consumed. */
function consume(consumed: boolean[], start: number, end: number): void {
  for (let i = start; i < end; i++) consumed[i] = true;
}

/** Parse a token as a number (digits or a spelled-out small word), or null. */
function tokenNumber(token: string | undefined): number | null {
  if (token === undefined) return null;
  if (/^\d+$/.test(token)) return Number(token);
  return token in NUMBER_WORDS ? NUMBER_WORDS[token]! : null;
}

/**
 * Match quantity comparisons — an operator phrase before a number ("more than 10"), or a
 * number followed by an operator phrase ("10 or more", "5 in stock"). Longest phrases win.
 */
function matchQuantityComparisons(tokens: readonly string[], consumed: boolean[], parts: PartSink): void {
  for (let i = 0; i < tokens.length; i++) {
    if (consumed[i]) continue;

    // "<operator phrase> <number>"
    const before = BEFORE_NUMBER.find((p) => phraseAt(tokens, consumed, i, p.tokens));
    if (before) {
      const numIndex = i + before.tokens.length;
      const n = consumed[numIndex] ? null : tokenNumber(tokens[numIndex]);
      if (n !== null) {
        const { condition, label } = before.build(n);
        parts.push({ kind: 'quantity', node: condition, label });
        let end = numIndex + 1;
        // Swallow a redundant metric restatement ("more than 100 in stock").
        const suffix = METRIC_SUFFIXES.find((s) => phraseAt(tokens, consumed, end, s));
        if (suffix) end += suffix.length;
        consume(consumed, i, end);
        continue;
      }
    }

    // "<number> <operator phrase>"
    const n = tokenNumber(tokens[i]);
    if (n !== null) {
      const after = AFTER_NUMBER.find((p) => phraseAt(tokens, consumed, i + 1, p.tokens));
      if (after) {
        const { condition, label } = after.build(n);
        parts.push({ kind: 'quantity', node: condition, label });
        consume(consumed, i, i + 1 + after.tokens.length);
      }
    }
  }
}

/** Match the fixed stock-level phrases (longest first, courtesy of {@link STOCK_PHRASES}). */
function matchStockLevels(
  tokens: readonly string[],
  consumed: boolean[],
  parts: PartSink,
  threshold: number,
): void {
  for (let i = 0; i < tokens.length; i++) {
    if (consumed[i]) continue;
    const phrase = STOCK_PHRASES.find((p) => phraseAt(tokens, consumed, i, p.tokens));
    if (!phrase) continue;
    const { condition, label } = phrase.build(threshold);
    parts.push({ kind: 'stock', node: condition, label });
    consume(consumed, i, i + phrase.tokens.length);
  }
}

/**
 * Match a location phrase: a preposition ("in"/"at"/"on"…), an optional determiner
 * ("the"/"my"…), then the longest run of tokens that names a known location. At most one
 * location is emitted (a second would AND to nothing under the id-equality predicate).
 */
function matchLocations(
  tokens: readonly string[],
  consumed: boolean[],
  parts: PartSink,
  locations: readonly NlLocation[],
): void {
  if (locations.length === 0) return;
  const byName = normalisedNameIndex(locations);
  const maxWords = byName.maxWords;

  for (let i = 0; i < tokens.length; i++) {
    if (consumed[i] || !LOCATION_PREPOSITIONS.has(tokens[i]!)) continue;
    // Try the name immediately after the preposition first (so a location literally named
    // "The Shed" still matches), then after skipping a determiner ("in the garage").
    const afterPrep = i + 1;
    const afterDeterminer =
      afterPrep < tokens.length && LOCATION_DETERMINERS.has(tokens[afterPrep]!) ? afterPrep + 1 : afterPrep;
    let nameStart = afterPrep;
    let match = longestNameMatch(tokens, consumed, afterPrep, maxWords, byName.map);
    if (!match && afterDeterminer !== afterPrep) {
      nameStart = afterDeterminer;
      match = longestNameMatch(tokens, consumed, afterDeterminer, maxWords, byName.map);
    }
    if (!match) continue;
    parts.push({
      kind: 'location',
      node: { field: 'location', operator: 'EQUALS', value: match.id },
      label: `In ${match.name}`,
    });
    consume(consumed, i, nameStart + match.words);
    return; // one location is enough
  }
}

/** Match a category name appearing anywhere as a contiguous run of unconsumed tokens. */
function matchCategories(
  tokens: readonly string[],
  consumed: boolean[],
  parts: PartSink,
  categories: readonly NlCategory[],
): void {
  if (categories.length === 0) return;
  const byName = normalisedNameIndex(categories);

  for (let i = 0; i < tokens.length; i++) {
    if (consumed[i]) continue;
    const match = longestNameMatch(tokens, consumed, i, byName.maxWords, byName.map);
    if (!match) continue;
    parts.push({
      kind: 'category',
      node: { field: 'category', operator: 'EQUALS', value: match.id },
      label: `Category: ${match.name}`,
    });
    consume(consumed, i, i + match.words);
    return; // one category is enough (a second would AND to nothing)
  }
}

/** A normalised name → {id, name} lookup plus the longest name's word count. */
function normalisedNameIndex(entries: readonly { id: string; name: string }[]): {
  map: Map<string, { id: string; name: string }>;
  maxWords: number;
} {
  const map = new Map<string, { id: string; name: string }>();
  let maxWords = 1;
  for (const entry of entries) {
    const key = entry.name.trim().toLowerCase().replace(/\s+/g, ' ');
    if (key.length === 0) continue;
    // First definition wins, so a stable, earliest match is deterministic across duplicates.
    if (!map.has(key)) map.set(key, { id: entry.id, name: entry.name });
    maxWords = Math.max(maxWords, key.split(' ').length);
  }
  return { map, maxWords };
}

/** The longest known name (up to `maxWords`) that starts at `start`, or null. */
function longestNameMatch(
  tokens: readonly string[],
  consumed: readonly boolean[],
  start: number,
  maxWords: number,
  map: ReadonlyMap<string, { id: string; name: string }>,
): { id: string; name: string; words: number } | null {
  const upper = Math.min(maxWords, tokens.length - start);
  for (let words = upper; words >= 1; words--) {
    let ok = true;
    for (let k = 0; k < words; k++) {
      if (consumed[start + k]) {
        ok = false;
        break;
      }
    }
    if (!ok) continue;
    const key = tokens.slice(start, start + words).join(' ');
    const hit = map.get(key);
    if (hit) return { ...hit, words };
  }
  return null;
}

/**
 * Build the residual free-text search from the unconsumed, non-filler tokens.
 *
 * Each leftover keyword is searched across **every** item text field ({@link
 * TEXT_SEARCH_FIELDS}) rather than the name alone, so a vaguer phrase whose words live in
 * an item's description, manufacturer or notes still surfaces it. Keywords are **ANDed**
 * (each must appear *somewhere*) while a single keyword may match in *any* field (**OR**) —
 * high recall without flooding the alphabetically-ordered results. Each keyword is
 * singularised and spelling-variant-expanded first. The result is a plain {@link SearchAST}
 * sub-tree the single {@link parseASTtoSQL} translator accepts; no SQL is hand-built here.
 */
function residualText(
  tokens: readonly string[],
  consumed: readonly boolean[],
): {
  kind: NlPartKind;
  node: PartNode;
  label: string;
} | null {
  // A preposition/determiner that didn't introduce a matched location is noise too.
  const words = tokens.filter(
    (t, i) =>
      !consumed[i] && !FILLER_WORDS.has(t) && !LOCATION_PREPOSITIONS.has(t) && !LOCATION_DETERMINERS.has(t),
  );
  if (words.length === 0) return null;

  const perKeyword = words.map((word) => buildKeywordGroup(singularise(word)));
  // One keyword needs no wrapping AND group; several are ANDed so every word must appear.
  const node: PartNode =
    perKeyword.length === 1
      ? perKeyword[0]!
      : { type: 'GROUP', logicalOperator: 'AND', conditions: perKeyword };

  return {
    kind: 'text',
    node,
    // Echo what the user typed (pre-normalisation) so the interpretation reads back clearly.
    label: `Matching “${words.join(' ')}”`,
  };
}

/**
 * Lower one residual keyword to an OR group of `<field> CONTAINS <variant>` leaves — one per
 * text field, per spelling variant — i.e. "match this word in any field, in either spelling".
 */
function buildKeywordGroup(keyword: string): ASTGroupNode {
  const variants = expandKeyword(keyword);
  const conditions: FilterCondition[] = [];
  for (const field of TEXT_SEARCH_FIELDS) {
    for (const variant of variants) {
      conditions.push({ field, operator: 'CONTAINS', value: variant });
    }
  }
  return { type: 'GROUP', logicalOperator: 'OR', conditions };
}

/** A keyword plus any {@link SPELLING_VARIANTS} spellings of it (the keyword always first). */
function expandKeyword(keyword: string): string[] {
  const variants = SPELLING_VARIANTS[keyword];
  return variants ? [keyword, ...variants] : [keyword];
}

/**
 * Best-effort singularisation of a query keyword, so a plural the user types also matches the
 * singular stored on an item (FTS prefix-matching already covers the reverse direction).
 * Deliberately conservative — it leaves short words and the common non-plural `-ss` / `-us` /
 * `-is` / `-ous` endings untouched, accepting the odd irregular word rather than over-stripping.
 */
function singularise(word: string): string {
  if (word.length <= 4) return word;
  if (word.endsWith('ies')) return `${word.slice(0, -3)}y`;
  if (/(ches|shes|sses|xes|zes)$/.test(word)) return word.slice(0, -2);
  if (word.endsWith('ss') || word.endsWith('us') || word.endsWith('is') || word.endsWith('ous')) return word;
  if (word.endsWith('s')) return word.slice(0, -1);
  return word;
}

/** True when `parseASTtoSQL` accepts the tree (the single SQL translator is the gate). */
function isTranslatable(ast: ASTGroupNode): boolean {
  try {
    parseASTtoSQL(ast);
    return true;
  } catch {
    return false;
  }
}
