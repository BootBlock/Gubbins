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
 * match is the right lookup.
 *
 * The **one** exception is UPC-E, which is not a width but a compressed UPC-A (issue
 * #508). Its printed eight digits carry the check digit of the *expanded* code, so the
 * mod-10 rule below cannot judge them as they stand, and the compressed form is neither
 * what a UPC-A scan of the same article yields nor how the product databases are keyed.
 * An 8-digit code is therefore expanded to its UPC-A when that is what it turns out to
 * be — see {@link parseGtin}. All logic here is pure and unit-tested.
 */
import { compressUpcA, expandUpcE } from './upce';

/**
 * The GTIN symbologies Gubbins recognises, by digit count (EAN-8, UPC-A, EAN-13, GTIN-14). Eight
 * digits also covers a printed UPC-E, which is a compressed UPC-A rather than a width of its own
 * — see {@link parseGtin}.
 */
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
 * Note this is **not** the rule for a printed UPC-E: those eight digits end in the check
 * digit of the 12-digit code they compress, so they are expanded first ({@link parseGtin}).
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
 * Resolve an 8-digit run of digits, which may be an EAN-8 *or* a compressed UPC-E, to its
 * canonical GTIN — the EAN-8 verbatim, or the UPC-E's 12-digit expansion — or `null` when it
 * is neither.
 *
 * Both readings can hold for the same eight digits (`01234565` validates either way), so the
 * order matters. GS1 reserves the GTIN-8 prefix `0` for exactly this compressed
 * representation, so a leading `0` is read as a UPC-E first and only falls back to EAN-8;
 * any other leading digit is read as an EAN-8 first, and as a UPC-E (number system `1`) only
 * if that fails.
 *
 * The UPC-E reading must also **round-trip**: the expansion has to compress back to the same
 * eight digits ({@link compressUpcA}). A handful of zero-heavy codes expand to a UPC-A that
 * compresses to a *different* UPC-E — `00000030` and `00000040` both expand to
 * `000000000000` — and accepting those would store two distinct printed codes as one value,
 * losing whichever was written second. No real UPC-E fails the round-trip.
 */
function resolveEightDigits(digits: string): string | null {
  const expanded = expandUpcE(digits);
  const upcA =
    expanded !== null && hasValidGtinCheckDigit(expanded) && compressUpcA(expanded) === digits
      ? expanded
      : null;
  if (upcA !== null && digits.startsWith('0')) return upcA;
  if (hasValidGtinCheckDigit(digits)) return digits;
  return upcA;
}

/**
 * Normalise a scanned/typed string to a canonical GTIN, or `null` when it is not one: a run
 * of digits of a recognised length ({@link GTIN_LENGTHS}) whose mod-10 check digit is correct.
 * Surrounding whitespace is ignored; any other character (letters, dashes, dots) makes it not
 * a GTIN.
 *
 * The result is the trimmed digit string as printed — no zero-padding — so it round-trips a
 * re-scan and keys the Open Food Facts lookup directly. A **UPC-E** is the exception: it is
 * returned as its expanded 12-digit UPC-A, which is the form a UPC-A scan of the same article
 * produces and the form the product databases index (see {@link resolveEightDigits}).
 */
export function parseGtin(raw: string): string | null {
  const digits = raw.trim();
  if (!isAllDigits(digits) || !GTIN_LENGTHS.includes(digits.length)) return null;
  if (digits.length === 8) return resolveEightDigits(digits);
  return hasValidGtinCheckDigit(digits) ? digits : null;
}

/**
 * True when `raw` is a syntactically valid GTIN — including a compressed UPC-E, which is
 * valid but normalises to a different string ({@link parseGtin}).
 *
 * @internal Exported for unit tests only.
 */
export function isValidGtin(raw: string): boolean {
  return parseGtin(raw) !== null;
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
 *
 * It shares {@link parseGtin}'s verdict rather than re-testing the check digit, so a
 * correctly transcribed UPC-E is never reported as mistyped.
 */
export function describeGtinConcern(raw: string): GtinConcern | null {
  const digits = raw.trim();
  if (!isAllDigits(digits)) return null;
  if (!GTIN_LENGTHS.includes(digits.length)) return 'length';
  return parseGtin(digits) === null ? 'check-digit' : null;
}

/**
 * Canonicalise a barcode **on its way into storage**, returning `raw` unchanged unless it is a
 * printed UPC-E — in which case the expanded 12-digit UPC-A replaces it (issue #508).
 *
 * Deliberately narrow. The field legitimately holds any code at all, and rewriting what someone
 * typed or imported is only justified where the two forms name the *same* article and only one of
 * them matches a scan: a UPC-E read off the pack would otherwise be stored as eight digits that no
 * camera scan of that product ever reproduces. Anything that is not an 8-digit code {@link
 * parseGtin} resolves to a 12-digit UPC-A is returned exactly as given — which includes an EAN-8
 * that is not also a valid UPC-E, and every non-GTIN code.
 *
 * Note the one case where an EAN-8 *is* rewritten: eight digits led by `0` that read validly both
 * ways are taken as the UPC-E, per the precedence in {@link resolveEightDigits}, so that a typed
 * code and a scan of the same pack agree.
 */
export function canonicaliseBarcode(raw: string): string {
  const digits = raw.trim();
  if (digits.length !== 8) return raw;
  const parsed = parseGtin(digits);
  return parsed !== null && parsed.length === 12 ? parsed : raw;
}

/**
 * Every stored form of one barcode, for a lookup that has to match them all: the value itself,
 * plus the compressed UPC-E when it is a UPC-A that compresses (issue #508).
 *
 * A barcode recorded before Gubbins expanded UPC-E codes still holds the eight digits printed on
 * the pack, while a scan of that pack now resolves to the twelve. Lookup is an exact match, so
 * without the second form those items would quietly stop being found — by the scanner, by the
 * Barcode field's duplicate advisory, by anything else that asks. Returned most-canonical first,
 * and never more than two.
 */
export function barcodeMatchForms(barcode: string): readonly string[] {
  const value = barcode.trim();
  const compressed = compressUpcA(value);
  return compressed === null || compressed === value ? [value] : [value, compressed];
}
