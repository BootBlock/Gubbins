/**
 * UPC-E expansion — the compressed 8-digit North-American retail code, restored to the
 * 12-digit UPC-A it stands for (issue #508).
 *
 * A UPC-E is not a GTIN width of its own: it is a **UPC-A with a run of zeroes squeezed
 * out**, printed on packaging too small to carry the full symbol. Neither the zxing reader
 * nor the native `BarcodeDetector` expands it — both hand back the eight printed digits —
 * and those eight digits carry no check digit of their own. The trailing digit is the check
 * digit of the *expanded* UPC-A, so testing it with the length-agnostic GTIN rule in
 * {@link ./gtin} rejects roughly nine real UPC-E codes in ten.
 *
 * Expanding on the way in fixes all three consequences at once: the code validates, the
 * value stored matches what a UPC-A scan of the same article would store, and the lookup key
 * becomes the one the product databases are indexed by.
 *
 * This module is **only** the expansion — a fully-specified table on the sixth body digit.
 * It deliberately does no check-digit work: `gtin.ts` owns the one mod-10 rule and applies
 * it to the expanded value, so there is a single definition of "valid" rather than two that
 * could drift. Pure and unit-tested.
 */

/**
 * True when `digits` has the *shape* of a UPC-E: exactly eight digits led by number system
 * 0 or 1 (the only two the symbology defines). Shape only — whether the code is genuine can
 * only be judged from the check digit of its expansion.
 *
 * @internal Exported for unit tests only.
 */
export function looksLikeUpcE(digits: string): boolean {
  return /^[01][0-9]{7}$/.test(digits);
}

/**
 * Expand a printed 8-digit UPC-E to the 12-digit UPC-A it compresses, or `null` when `raw`
 * is not UPC-E-shaped ({@link looksLikeUpcE}). Surrounding whitespace is ignored.
 *
 * The expansion re-inserts the zero run the symbology squeezed out, chosen by the **last
 * body digit** `d6` (`N d1 d2 d3 d4 d5 d6 C` → UPC-A `N …ten digits… C`):
 *
 * | `d6`  | Ten middle digits          |
 * | ----- | -------------------------- |
 * | 0–2   | `d1 d2 d6 0 0 0 0 d3 d4 d5` |
 * | 3     | `d1 d2 d3 0 0 0 0 0 d4 d5` |
 * | 4     | `d1 d2 d3 d4 0 0 0 0 0 d5` |
 * | 5–9   | `d1 d2 d3 d4 d5 0 0 0 0 d6` |
 *
 * The number system and the check digit are carried across unchanged. The result is **not**
 * validated here — the caller applies the shared mod-10 rule (see the module note).
 */
export function expandUpcE(raw: string): string | null {
  const digits = raw.trim();
  if (!looksLikeUpcE(digits)) return null;
  const [n, d1, d2, d3, d4, d5, d6, check] = digits;
  const middle =
    d6 === '0' || d6 === '1' || d6 === '2'
      ? `${d1}${d2}${d6}0000${d3}${d4}${d5}`
      : d6 === '3'
        ? `${d1}${d2}${d3}00000${d4}${d5}`
        : d6 === '4'
          ? `${d1}${d2}${d3}${d4}00000${d5}`
          : `${d1}${d2}${d3}${d4}${d5}0000${d6}`;
  return `${n}${middle}${check}`;
}

/**
 * Compress a 12-digit UPC-A to the UPC-E an encoder would print for it, or `null` when none
 * would. This is the **GS1 encoder**: its four branches are the four zero-suppression rules in
 * the priority order the standard applies them, which is why the first matching branch wins even
 * where a later one also fits.
 *
 * It is *not* a plain inverse of {@link expandUpcE}. More than one UPC-E can expand to the same
 * UPC-A — around 9% of the 8-digit space does — and this returns the one the standard would have
 * printed. What holds in the direction that matters is that `expandUpcE(compressUpcA(a))` is
 * `a` for every UPC-A a UPC-E expands to, so every code a real symbol carries survives the
 * round-trip. `upce.test.ts` enumerates the whole space and asserts exactly that.
 *
 * Two things need it. {@link ./gtin}'s round-trip guard uses it to tell a printed UPC-E from
 * eight digits that merely happen to expand, which is what keeps two distinct codes from
 * collapsing onto one stored value. And a barcode recorded before Gubbins expanded UPC-E codes
 * still holds the compressed form, so a lookup has to be able to ask for it.
 */
export function compressUpcA(raw: string): string | null {
  const digits = raw.trim();
  if (!/^[01][0-9]{11}$/.test(digits)) return null;
  const n = digits[0];
  const m = digits.slice(1, 11); // the ten data digits between number system and check digit
  const check = digits[11];
  const body =
    m[2]! <= '2' && m.slice(3, 7) === '0000'
      ? `${m[0]}${m[1]}${m[7]}${m[8]}${m[9]}${m[2]}`
      : m.slice(3, 8) === '00000'
        ? `${m[0]}${m[1]}${m[2]}${m[8]}${m[9]}3`
        : m.slice(4, 9) === '00000'
          ? `${m[0]}${m[1]}${m[2]}${m[3]}${m[9]}4`
          : m.slice(5, 9) === '0000' && m[9]! >= '5'
            ? `${m[0]}${m[1]}${m[2]}${m[3]}${m[4]}${m[9]}`
            : null;
  return body === null ? null : `${n}${body}${check}`;
}
