/**
 * Text length limits (issue #346) — the one place the app says how long a piece of typed text
 * may be.
 *
 * Before this, nothing bounded a user-editable string anywhere: the item schema was
 * `z.string().trim().min(1)` with no ceiling, the repository only trimmed and checked
 * non-empty, and `items.name` was a plain `TEXT NOT NULL` among eighty-nine CHECK constraints
 * that constrained everything except a length. A fifty-thousand-character name — pasted, or
 * arriving from one runaway import cell — was accepted end to end and then carried into the
 * FTS index, every list row, the printed label and the CSV export.
 *
 * The limits are **tiers, not per-field numbers**. A field is one of a small number of shapes —
 * a short code, one line of prose, a paragraph, a web address, a stored payload — and naming the
 * shape is what keeps the schema CHECK, the repository validator and the control on screen
 * agreeing about the same field. Per-field numbers would drift apart the first time one of the
 * three was edited alone.
 *
 * Every tier is deliberately far above anything a real entry reaches. The point is to stop the
 * runaway, not to ration typing: a limit a user meets in ordinary work is a bug in the limit.
 *
 * **Nothing here truncates.** The tiers say what is too long; they never shorten a value to fit.
 * That is the contract the app already keeps for numbers — see `numeric-bounds.ts`, where
 * settling an out-of-range entry to the nearest legal one did real damage before it was
 * reverted — and text is no different: silently dropping the tail of a paste loses work the user
 * cannot see has gone. The single exception is {@link truncateByCodePoints}, which exists for
 * **derived** strings (a download filename), never for a value on its way to storage.
 */

/**
 * How long a piece of text of each shape may be, in Unicode code points.
 *
 * Counted in code points because that is what SQLite's `length()` counts, so a column CHECK and
 * the control that feeds it agree about an emoji or an astral-plane CJK character, instead of
 * the schema accepting what the control had already reported as too long.
 */
export const TEXT_LIMITS = {
  /**
   * A token the **app** settles the shape of rather than the user: a currency code, a glyph, an
   * icon name, a colour, a priority.
   *
   * Deliberately not used for a code the user types in free — an order code, a purchase-order
   * reference, a barcode read from a QR that turns out to hold a URL. Those look short and are
   * not reliably short, and a tight cap on one is a limit somebody meets in ordinary work; they
   * take {@link TEXT_LIMITS.line} like any other single-line entry.
   */
  code: 64,
  /**
   * One line of typed prose: a name, a title, a label, a caption, a manufacturer, an MPN, an
   * address, an email address, a phone number, a unit of measure. The default for every
   * single-line control in the app.
   */
  line: 500,
  /** A web address. About the length mainstream browsers are willing to navigate to. */
  url: 2048,
  /**
   * A paragraph or several: a description, a note, a comment. The default for every multi-line
   * control in the app.
   */
  note: 20_000,
  /**
   * A stored payload rather than prose — serialised JSON, a webhook body template, an inline
   * base64 image, a block of pasted CSV waiting to be imported. Bounded only so that one row
   * cannot grow without limit; a value near this ceiling is normal for an `IMAGE` custom field,
   * whose 512 KiB WebP becomes about 700,000 base64 characters.
   */
  payload: 1_000_000,
} as const;

/** The name of one of the {@link TEXT_LIMITS} tiers. */
export type TextLimitTier = keyof typeof TEXT_LIMITS;

/** Any UTF-16 surrogate code unit, i.e. half of a character from outside the basic plane. */
const SURROGATE = /[\uD800-\uDFFF]/;

/**
 * The length of `text` as the limits measure it: Unicode code points, not UTF-16 code units.
 *
 * `'🔧'.length` is 2 because the character needs a surrogate pair to be stored, which is an
 * implementation detail of JavaScript's string type and not something a user should be charged
 * twice for. SQLite's `length()` counts that character once, so counting code units here would
 * have a control report a value as too long that the column would happily have taken.
 */
export function textLength(text: string): number {
  // Fast path for the overwhelmingly common case: a string holding no surrogate at all has the
  // same code-point and code-unit count, and testing for one is far cheaper than walking a long
  // note character by character.
  if (!SURROGATE.test(text)) return text.length;
  return [...text].length;
}

/** Whether `text` is longer than `limit` allows. A limit that is not a positive number bounds nothing. */
export function exceedsTextLimit(text: string, limit: number): boolean {
  if (!Number.isFinite(limit) || limit <= 0) return false;
  return textLength(text) > limit;
}

/**
 * A predicate saying whether one value fits inside `limit` — the shape a schema refinement
 * wants (`z.string().refine(withinTextLimit(TEXT_LIMITS.line), '…')`).
 *
 * Zod's own `.max()` would be the obvious thing to reach for, and it is the wrong unit: it
 * counts UTF-16 code units, so a name of two hundred and sixty emoji would be refused as
 * over five hundred while the control beside it, the repository behind it and the column
 * under it all counted two hundred and sixty. A form that refuses what everything else accepts
 * is worse than no form validation at all.
 */
export function withinTextLimit(limit: number): (text: string) => boolean {
  return (text) => !exceedsTextLimit(text, limit);
}

/**
 * The first `max` **code points** of `text`.
 *
 * For derived strings only — an export filename built from an item name, say. A UTF-16
 * `slice()` cuts between the two halves of a surrogate pair whenever the boundary lands
 * mid-character, leaving a lone surrogate in the result: a filename holding one is
 * unrepresentable, and it round-trips through JSON as U+FFFD. Iterating the string yields whole
 * characters, so the cut always falls between them.
 *
 * Never use this on something a user typed and expects to be stored — see this module's note.
 */
export function truncateByCodePoints(text: string, max: number): string {
  if (!Number.isFinite(max) || max <= 0) return '';
  // A string no longer than `max` code units cannot be longer than `max` code points either,
  // so there is nothing to cut and no need to walk it.
  if (text.length <= max) return text;
  let out = '';
  let count = 0;
  for (const character of text) {
    if (count >= max) break;
    out += character;
    count += 1;
  }
  return out;
}
