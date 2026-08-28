/**
 * The one precision rule the measurement formatters share (issue #416).
 *
 * A measurement is stored canonically — grams for a weight, millimetres for a dimension — and
 * re-expressed in whatever unit the user reads it in. Once that unit can be much *coarser* than
 * the canonical one (a stone is 6350 g; a yard is 914.4 mm), a flat "three decimal places" cap
 * starts erasing real values: a 500 mg part reads `0 st`, and a 0.4 mm shim reads `0 yd`. A flat
 * "three significant figures" cap is no good either — it would turn `1,234 mm` into `1,230 mm`.
 *
 * So the rule keys off the magnitude of the value *as displayed*: at one unit or more, cap the
 * fraction digits and keep every integer digit; below one unit, cap the significant figures
 * instead, so a small quantity keeps three figures of its own however far below 1 it lands.
 *
 * Side-effect-free and dependency-free so both `lib/weight.ts` and `lib/dimensions.ts` can share
 * it without either importing the other, and so the rule is unit-tested once rather than twice.
 */

/**
 * `Intl.NumberFormat` options for displaying `value` in the user's chosen measurement unit.
 * Trailing zeros are trimmed in both branches (`250 mm`, not `250.000 mm`), because neither
 * option sets a *minimum* digit count.
 */
export function measurementFormatOptions(value: number): Intl.NumberFormatOptions {
  return Math.abs(value) >= 1 ? { maximumFractionDigits: 3 } : { maximumSignificantDigits: 3 };
}

/**
 * Render a converted measurement as an **entry-field** string, with the conversion's
 * floating-point noise trimmed — so a stored `1250 mm` reads `1.25` in metres, not
 * `1.2500000001`.
 *
 * The trim is six decimal places at one unit or more, and six significant figures below one, for
 * the same reason {@link measurementFormatOptions} switches: six decimals is ample resolution for
 * a value counted in whole units, but it is *coarser than the unit itself* once the unit is much
 * larger than the canonical one. A half-gram part shown in stones would trim to `0.000079`, and
 * re-saving that untouched-looking figure would quietly move the stored weight by 0.3%.
 */
export function trimMeasureNoise(value: number): string {
  return String(Number(Math.abs(value) >= 1 ? value.toFixed(6) : value.toPrecision(6)));
}
