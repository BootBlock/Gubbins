/**
 * GTIN (retail barcode) recognition — the pure decode step behind the scanner's
 * "unknown product" fallback (recommendation point 1).
 *
 * A retail article carries a **GTIN**: EAN-13 (the ubiquitous 13-digit European
 * article number, which also encodes ISBN-13), UPC-A (12 digits, North America),
 * EAN-8 (8 digits, small packages) and GTIN-14 (ITF-14 case/carton code). All four
 * are a run of digits terminated by a **mod-10 check digit**, so a scan that decodes
 * to a valid GTIN can be told apart from arbitrary noise with certainty — no network,
 * no database. This module does exactly that and nothing more: it validates the
 * length and check digit and returns the normalised digit string. The camera side
 * feeds raw decoded strings into {@link parseGtin}; {@link parseScannedCode} uses it
 * as the final fallback once a code proves not to be a Gubbins deep-link.
 *
 * The barcode is stored on the item **verbatim as printed** (no zero-padding to a
 * canonical width): that is the value a human reads off the packaging, the value the
 * Open Food Facts API is keyed by, and the value a re-scan reproduces — so an exact
 * match is the right lookup. All logic here is pure and unit-tested.
 */

/** The GTIN symbologies Gubbins recognises, by digit count (EAN-8, UPC-A, EAN-13, GTIN-14). */
export const GTIN_LENGTHS: readonly number[] = [8, 12, 13, 14];

/** True when `raw` (after trimming) is only ASCII digits. */
function isAllDigits(value: string): boolean {
  return value.length > 0 && /^[0-9]+$/.test(value);
}

/**
 * Validate a digit string's trailing **mod-10 check digit** (the GS1 standard shared by
 * every GTIN width). Weights alternate 3,1 anchored at the check digit — the data digit
 * immediately to its left is weighted 3 — which makes the rule length-agnostic across
 * GTIN-8/12/13/14. Returns false for anything that is not a run of digits.
 *
 * @internal Exported for unit tests only.
 */
export function hasValidGtinCheckDigit(digits: string): boolean {
  if (!isAllDigits(digits)) return false;
  const n = digits.length;
  let sum = 0;
  for (let i = 0; i < n - 1; i += 1) {
    const distanceFromCheck = n - 1 - i; // 1 = digit just left of the check digit
    const weight = distanceFromCheck % 2 === 1 ? 3 : 1;
    sum += (digits.charCodeAt(i) - 48) * weight;
  }
  const check = (10 - (sum % 10)) % 10;
  return check === digits.charCodeAt(n - 1) - 48;
}

/**
 * True when `raw` is a syntactically valid GTIN: a run of digits of a recognised length
 * ({@link GTIN_LENGTHS}) whose mod-10 check digit is correct. Surrounding whitespace is
 * ignored; any other character (letters, dashes, dots) makes it not a GTIN.
 *
 * @internal Exported for unit tests only.
 */
export function isValidGtin(raw: string): boolean {
  const digits = raw.trim();
  return GTIN_LENGTHS.includes(digits.length) && hasValidGtinCheckDigit(digits);
}

/**
 * Why a hand-typed barcode looks wrong (issue #344). Both concerns are **advisory**, never
 * blocking: the field legitimately holds non-retail codes (an internal Code-128 label, a
 * shelf code), so only an unambiguously GTIN-shaped entry — a run of digits and nothing
 * else — is ever judged at all.
 *
 * - `check-digit` — a recognised GTIN width whose mod-10 check digit fails, i.e. almost
 *   certainly a mistyped or transposed digit. Lookup is an exact match (see the module
 *   note above), so such an item would never resolve on a re-scan.
 * - `length` — digits only, but not 8/12/13/14, so it is not a GTIN of any width.
 */
export type GtinConcern = 'check-digit' | 'length';

/**
 * Judge a **typed** barcode entry, returning why it looks wrong or `null` when there is
 * nothing to say. Blank, and anything containing a non-digit character, return `null` —
 * see {@link GtinConcern} for why this deliberately stays quiet rather than policing the
 * field. Pure: the caller decides how (and how loudly) to surface the result.
 */
export function describeGtinConcern(raw: string): GtinConcern | null {
  const digits = raw.trim();
  if (!isAllDigits(digits)) return null;
  if (!GTIN_LENGTHS.includes(digits.length)) return 'length';
  return hasValidGtinCheckDigit(digits) ? null : 'check-digit';
}

/**
 * Normalise a scanned/typed string to a canonical GTIN, or `null` when it is not one.
 * The canonical form is simply the trimmed digit string as printed on the article — no
 * zero-padding — so it round-trips a re-scan and keys the Open Food Facts lookup directly.
 */
export function parseGtin(raw: string): string | null {
  const digits = raw.trim();
  return isValidGtin(digits) ? digits : null;
}
