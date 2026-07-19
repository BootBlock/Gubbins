/**
 * Strip the binary-float noise that IEEE-754 arithmetic leaves on decimal values, so a
 * figure written into an export reads the way it reads on screen (issue #291).
 *
 * `0.1 + 0.2` is `0.30000000000000004` as a double, and `String()` faithfully prints all
 * 17 digits — which is how a valuation CSV handed to an accountant ends up showing
 * `0.30000000000000004` where the app shows `£0.30`. A double carries just under 16
 * significant decimal digits of real precision, so re-rounding to 15 discards exactly the
 * digits that are artefacts of the representation and keeps every digit that is data.
 *
 * Pure and format-agnostic — the tabular / CSV / XLSX serialisers all route their numeric
 * cells through it rather than each re-deriving a rounding rule.
 */

/**
 * Round `value` to 15 significant decimal digits, dropping representation noise
 * (`0.1 + 0.2` → `0.3`, `0.1 * 3` → `0.3`).
 *
 * Integers and non-finite values (`NaN`, `±Infinity`) are returned untouched: this class of
 * artefact only appears in the fractional part, and rounding an integer would *lose* data
 * rather than tidy it (`Number.MAX_SAFE_INTEGER` needs 16 significant digits).
 */
export function stripFloatNoise(value: number): number {
  if (!Number.isFinite(value) || Number.isInteger(value)) return value;
  // `toPrecision` may emit exponential form for very large / small magnitudes; `Number`
  // parses that back, and re-printing chooses the shortest round-tripping form again.
  return Number(value.toPrecision(15));
}
