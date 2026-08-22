/**
 * Numeric bounds (issue #676) — the pure seam behind {@link NumberInput}.
 *
 * Every number field in the app is a `type="text"` box, because it has to be able to hold
 * the calculator's operator characters (see {@link evaluateExpression}). `min`, `max` and
 * `step` are only meaningful to the browser on a `number`/`range`/date input, so on that
 * text box they are inert markup: no stepper, no validity, no announced range. Around sixty
 * call sites declare a range that way, so the arithmetic has to live here instead.
 *
 * It does the three jobs the browser does with those attributes, and no more: it bounds the
 * stepper ({@link stepFrom}), it says whether a value is inside the range at all
 * ({@link applyBounds}), and it reads the attributes themselves ({@link resolveBounds}). It is
 * deliberately not used to rewrite a value somebody typed — see {@link NumberInput}'s note on
 * why settling an out-of-range entry to the nearest legal one did more harm than good.
 *
 * Everything here is pure and framework-free, so the awkward cases — float noise, a step
 * measured from a non-zero `min`, a value that both mis-steps and overflows — are testable
 * without a DOM.
 */

/**
 * The characters a numeric field accepts: digits, a decimal point, an exponent marker,
 * whitespace, the calculator's operators — and a comma.
 *
 * The comma is deliberately *allowed in but never valid*. Dropping it would be guessing: `1,250`
 * means one thousand two hundred and fifty to a British reader, and `250,00` means two hundred
 * and fifty to a German one — and this app ships a German catalogue. Silently removing the
 * character turns the second into `25000`, a hundredfold error with nothing on screen to notice.
 * Left in place it parses as nothing, so the entry is reported the way issue #675 established and
 * the user retypes it. Every other out-of-grammar character is unambiguous rubbish, and is dropped.
 *
 * `e` earns its place for the same reason the digits do: it is part of a number. The calculator
 * writes its own result back through the field, and {@link formatCalcResult} emits exponential
 * form beyond about 1e21 or below 1e-6 — so stripping the marker would turn its own `1e-7` into
 * `1-7`, which the next commit reads as a subtraction and settles to `-6`.
 */
const ALLOWED_CHARS = new Set('0123456789.,eE \t+-*/^%×÷−()'.split(''));

/** A resolved numeric range, with any attribute that isn't a finite number dropped. */
export interface NumericBounds {
  readonly min?: number;
  readonly max?: number;
  /** The step increment. Always positive; `step="any"` resolves to `undefined` (no step). */
  readonly step?: number;
}

/** The outcome of {@link applyBounds}: the value to use, and whether it had to be moved. */
export interface BoundedValue {
  readonly value: number;
  /** Whether the value was out of range or off-step and has been corrected. */
  readonly adjusted: boolean;
}

/** Coerce one HTML numeric attribute to a finite number, or `undefined` if it isn't one. */
function toFinite(attribute: unknown): number | undefined {
  if (attribute === undefined || attribute === null || attribute === '') return undefined;
  const value = typeof attribute === 'number' ? attribute : Number(attribute);
  return Number.isFinite(value) ? value : undefined;
}

/**
 * Read a `min` / `max` / `step` attribute trio into a {@link NumericBounds}. Anything that
 * isn't a finite number is dropped, so the HTML `step="any"` sentinel — and a `step={0}` or
 * negative step, which HTML also treats as no constraint — all mean "no step".
 */
export function resolveBounds(min: unknown, max: unknown, step: unknown): NumericBounds {
  const stepValue = toFinite(step);
  const minValue = toFinite(min);
  const maxValue = toFinite(max);
  return {
    min: minValue,
    // A ceiling below the floor describes no value at all, and it happens when a `max` comes
    // from live data that has run out — `min={1} max={available}` with nothing available. Honour
    // the floor and drop the ceiling rather than reporting every entry as out of range and
    // handing assistive tech an `aria-valuemax` beneath its own `aria-valuemin`.
    max: maxValue !== undefined && minValue !== undefined && maxValue < minValue ? undefined : maxValue,
    step: stepValue !== undefined && stepValue > 0 ? stepValue : undefined,
  };
}

/** Whether any bound at all was declared, i.e. whether the field has a range to enforce. */
export function hasBounds(bounds: NumericBounds): boolean {
  return bounds.min !== undefined || bounds.max !== undefined || bounds.step !== undefined;
}

/**
 * Trim the binary-floating-point noise that `0.1 * 3` style arithmetic leaves behind.
 *
 * A whole number comes back untouched: it is already exact, so rounding it to a fixed count of
 * significant digits would *lose* precision rather than trim noise — a thirteen-digit count would
 * come back changed, and be reported as an adjustment it never needed. Fifteen significant digits
 * is inside a double's exact range, so the artefacts go without real precision going with them.
 */
function trimFloatNoise(value: number): number {
  if (Number.isInteger(value)) return value;
  return Number(value.toPrecision(15));
}

/**
 * The nearest value the declared range allows: the step grid snapped, then `[min, max]`
 * clamped — the same order, and the same grid origin, a native `type="number"` field uses (the
 * step is measured from `min` when there is one, else from zero, so `min={1} step={2}` accepts
 * 1, 3, 5 and not 2). Clamping happens *after* stepping so a value that snaps past `max` still
 * lands on `max`, which — exactly as in HTML — may itself sit off the grid; the endpoint a call
 * site declared is always reachable.
 *
 * `adjusted` is the useful half at a typed value: it says the entry is outside the range, which
 * is what marks the field invalid. The `value` beside it is for the stepper, which lands on a
 * legal rung by definition. Do not use it to overwrite what somebody typed.
 */
export function applyBounds(value: number, bounds: NumericBounds): BoundedValue {
  let result = value;
  if (bounds.step !== undefined) {
    const origin = bounds.min ?? 0;
    result = trimFloatNoise(origin + Math.round((result - origin) / bounds.step) * bounds.step);
  }
  if (bounds.min !== undefined && result < bounds.min) result = bounds.min;
  if (bounds.max !== undefined && result > bounds.max) result = bounds.max;
  return { value: result, adjusted: result !== value };
}

/**
 * The value one press of Up (`direction: 1`) or Down (`direction: -1`) should produce, given
 * the field's current numeric value — `null` when the box is blank or mid-calculation, in
 * which case stepping starts from the bottom of the range (or zero).
 *
 * A step of 1 is assumed where none is declared, matching the native spinbutton default. An
 * off-grid value moves to the next grid point in the direction of travel rather than a whole
 * step past it (Up from `2.4` with `step={1}` gives `3`, Down gives `2`), which is what a
 * native `type="number"` field does.
 */
export function stepFrom(current: number | null, bounds: NumericBounds, direction: 1 | -1): number {
  const increment = bounds.step ?? 1;
  if (current === null) return applyBounds(bounds.min ?? 0, bounds).value;
  const origin = bounds.min ?? 0;
  const grid = trimFloatNoise((current - origin) / increment);
  const rung = direction === 1 ? Math.floor(grid) + 1 : Math.ceil(grid) - 1;
  const next = trimFloatNoise(origin + rung * increment);
  return applyBounds(next, bounds).value;
}

/**
 * Strip everything a numeric field cannot mean from typed or pasted text, leaving the characters
 * {@link ALLOWED_CHARS} lists.
 *
 * This is what stops a letter or a multi-line paste reaching the field and becoming a silent
 * `NaN` downstream. Removing the character as it arrives shows the user the result immediately,
 * which a deferred validation message does not. A comma survives on purpose — see
 * {@link ALLOWED_CHARS} for why guessing what one means is worse than reporting it.
 */
export function sanitiseNumericText(text: string): string {
  let out = '';
  for (const ch of text) if (ALLOWED_CHARS.has(ch)) out += ch;
  return out;
}

/**
 * How many characters {@link sanitiseNumericText} removes from the first `upTo` characters of
 * `text` — the amount a caret sitting at `upTo` has to move left to stay where the user left it.
 */
export function removedBefore(text: string, upTo: number): number {
  const head = text.slice(0, upTo);
  return head.length - sanitiseNumericText(head).length;
}

/**
 * Read a field's raw text as a number, or `null` when it does not denote one.
 *
 * Whitespace is dropped first, so a `1 000` typed or pasted with a thousands space reads as
 * `1000` rather than `NaN` — the field's own grammar allows spaces (`2 + 3`), so they cannot
 * simply be rejected on entry. Infinities (`1e400`) and blanks report `null` alongside plain
 * nonsense, so no caller has to re-check for a non-finite result.
 */
export function parseNumericText(text: string): number | null {
  const compact = text.replace(/\s+/g, '');
  if (compact === '') return null;
  const value = Number(compact);
  return Number.isFinite(value) ? value : null;
}
