import { describe, expect, it } from 'vitest';
import {
  TEXT_LIMITS,
  exceedsTextLimit,
  textLength,
  truncateByCodePoints,
  withinTextLimit,
} from './text-limits';

/** A spanner, U+1F527 — one character, two UTF-16 code units. */
const SPANNER = '🔧';

/**
 * Whether `text` holds half of a surrogate pair with nothing on the other side of it.
 *
 * A *paired* surrogate is ordinary and expected — it is how JavaScript stores the spanner — so
 * a bare `/[\uD800-\uDFFF]/` would flag every string holding an emoji. The unpaired half is the
 * defect.
 */
function hasLoneSurrogate(text: string): boolean {
  return /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(text);
}

describe('textLength', () => {
  it('counts an ASCII string by its characters', () => {
    expect(textLength('')).toBe(0);
    expect(textLength('Resistor 10k')).toBe(12);
  });

  it('counts a character outside the basic plane once, not twice', () => {
    expect(SPANNER.length).toBe(2);
    expect(textLength(SPANNER)).toBe(1);
    expect(textLength(`a${SPANNER}b`)).toBe(3);
  });

  it('agrees with the length SQLite would report for the same string', () => {
    // The column CHECKs are written as `length(col) <= N`, and SQLite's `length()` counts
    // characters. A disagreement here would let the schema accept what a control refused.
    expect(textLength(`${SPANNER}${SPANNER}`)).toBe(2);
  });
});

describe('exceedsTextLimit', () => {
  it('is false at the limit and true one character past it', () => {
    expect(exceedsTextLimit('abc', 3)).toBe(false);
    expect(exceedsTextLimit('abcd', 3)).toBe(true);
  });

  it('measures an emoji as one character, not two', () => {
    expect(exceedsTextLimit(SPANNER.repeat(3), 3)).toBe(false);
    expect(exceedsTextLimit(SPANNER.repeat(4), 3)).toBe(true);
  });

  it('bounds nothing when the limit is not a positive number', () => {
    expect(exceedsTextLimit('anything at all', 0)).toBe(false);
    expect(exceedsTextLimit('anything at all', Number.NaN)).toBe(false);
    expect(exceedsTextLimit('anything at all', Number.POSITIVE_INFINITY)).toBe(false);
  });
});

describe('withinTextLimit', () => {
  it('reads as a schema refinement, and inverts exceedsTextLimit', () => {
    const withinOneLine = withinTextLimit(TEXT_LIMITS.line);
    expect(withinOneLine('a'.repeat(TEXT_LIMITS.line))).toBe(true);
    expect(withinOneLine('a'.repeat(TEXT_LIMITS.line + 1))).toBe(false);
  });
});

describe('truncateByCodePoints', () => {
  it('leaves a string that already fits exactly alone', () => {
    expect(truncateByCodePoints('Bench drawer', 80)).toBe('Bench drawer');
    expect(truncateByCodePoints('abc', 3)).toBe('abc');
  });

  it('cuts to whole characters', () => {
    expect(truncateByCodePoints('abcdef', 3)).toBe('abc');
    expect(truncateByCodePoints(SPANNER.repeat(5), 2)).toBe(SPANNER.repeat(2));
  });

  it('never leaves a lone surrogate at the cut — the export-filename defect (issue #346)', () => {
    // The boundary falls in the middle of the spanner: a UTF-16 slice keeps its leading half,
    // which no filesystem can name and which JSON round-trips as U+FFFD.
    const name = `${'a'.repeat(79)}${SPANNER}b`;
    expect(hasLoneSurrogate(name.slice(0, 80))).toBe(true);

    const cut = truncateByCodePoints(name, 80);
    expect(hasLoneSurrogate(cut)).toBe(false);
    expect(cut).toBe(`${'a'.repeat(79)}${SPANNER}`);
    expect(textLength(cut)).toBe(80);
  });

  it('returns nothing for a limit that admits nothing', () => {
    expect(truncateByCodePoints('abc', 0)).toBe('');
    expect(truncateByCodePoints('abc', -1)).toBe('');
    expect(truncateByCodePoints('abc', Number.NaN)).toBe('');
  });
});

describe('TEXT_LIMITS', () => {
  it('orders the tiers from the tightest shape to the roomiest', () => {
    expect(TEXT_LIMITS.code).toBeLessThan(TEXT_LIMITS.line);
    expect(TEXT_LIMITS.line).toBeLessThan(TEXT_LIMITS.url);
    expect(TEXT_LIMITS.url).toBeLessThan(TEXT_LIMITS.note);
    expect(TEXT_LIMITS.note).toBeLessThan(TEXT_LIMITS.payload);
  });

  it('leaves the payload tier room for an inline IMAGE custom field', () => {
    // A 512 KiB WebP becomes roughly 700,000 base64 characters, and it is stored in the same
    // TEXT column as every other custom-field value. A payload tier under that would refuse a
    // picture the app itself had just encoded.
    const base64CharactersFor512KiB = Math.ceil((512 * 1024) / 3) * 4;
    expect(TEXT_LIMITS.payload).toBeGreaterThan(base64CharactersFor512KiB);
  });
});
