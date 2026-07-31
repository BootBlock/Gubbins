/**
 * The **decimal places** a `NUMBER` custom field is quoted to (W1e) — one rule, seen from its two
 * sides.
 *
 * `field_defs.precision` is the odd one out among a definition's number settings. A unit only
 * labels a value and a range only refuses one; a precision does both. It refuses a value carrying
 * more decimals than the field allows, *and* it decides how a stored value is written wherever it
 * is displayed — `5.5` on a two-decimal field reads `5.50`. Shipping only the first half would
 * read as a defect: someone who sets 2 dp and still sees `5.5` will call it a bug.
 *
 * The two halves are literally the same call. {@link formatFieldNumber} writes the value at the
 * definition's precision; {@link fitsFieldPrecision} asks whether doing so would lose anything.
 * So a value the validator accepted is one the renderer only ever *pads*, and rounding is reserved
 * for a value that arrived without meeting the validator at all — merged from a sync peer,
 * restored from a backup, or left behind when the precision was tightened afterwards.
 *
 * **These numbers are deliberately not locale-formatted, unlike money and quantities.** The app has
 * a full `useFormatters` / Foundry `Money` seam for numbers that are, and a custom `NUMBER` does
 * not join it. Three reasons, none of them inertia:
 *
 * 1. **Grouping would be wrong as often as right.** `Formatters.quantity` groups because it
 *    formats a *count*; a custom number is whatever the user made it. A definition named "Year
 *    built" holding `2026` would render `2,026`.
 * 2. **There is no locale-aware way to type one back in.** A `NUMBER` value box is the Foundry
 *    calculator `Input`, whose grammar (`foundry/evaluate-expression.ts`) parses `.`-decimals
 *    only. A card reading `5,50` under a German locale could not be retyped into the control that
 *    set it.
 * 3. **Every other surface publishes the stored string verbatim.** `field:` search comparisons
 *    match on it, the CSV export writes it, and the bridge serves it. A grouped or
 *    comma-separated card would be the one surface spelling the value differently from the four
 *    around it.
 *
 * So this is a fixed-decimal rendering of the canonical form — the same non-locale terms the value
 * is already stored and already shown in — and not an `Intl.NumberFormat` call.
 */

/**
 * Write a stored `NUMBER` value at its definition's precision, or return it unchanged when the
 * definition sets none.
 *
 * Total by construction. `precision` of `null` is "as entered", which is what every field had
 * before W1e, so an unset definition renders byte-identically to before. A `raw` that does not
 * parse as a finite number is returned unchanged rather than shown as `NaN`: only the write seam
 * guarantees a canonical number is stored, and a value from a peer, an import or a hand-edited
 * backup has met no such guarantee.
 *
 * The blank guard is not redundant with that. `Number('')` and `Number(' ')` are both `0` — the
 * long-standing JavaScript trap this codebase already writes around in `validateFieldValue` and
 * `resolveBound` — so without it an empty value would render as a confident `0.00`. Every caller
 * happens to drop blanks first, which is exactly why the guard belongs here rather than there.
 */
export function formatFieldNumber(raw: string, precision: number | null): string {
  if (precision === null || raw.trim() === '') return raw;
  const n = Number(raw);
  if (!Number.isFinite(n)) return raw;
  return n.toFixed(precision);
}

/**
 * Does `n` survive being written at `precision` decimal places? — the constraint half of the same
 * rule {@link formatFieldNumber} applies.
 *
 * Asked as a round trip rather than by counting the digits in `String(n)`, for two reasons. It is
 * the *display* call, so a value the validator accepts can never render as something else; and
 * `String(n)` is not a reliable digit count anyway — it switches to exponential form at the
 * extremes, where `1e-7` shows no decimal point at all yet is plainly not a two-decimal value.
 *
 * The comparison is against the **parsed** number, not the text the user typed, so `5.50` entered
 * into a one-decimal field is accepted: it *is* a one-decimal value, merely written long. Only a
 * value that genuinely cannot be expressed at this precision is refused.
 */
export function fitsFieldPrecision(n: number, precision: number): boolean {
  return Number(n.toFixed(precision)) === n;
}
