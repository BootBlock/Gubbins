/**
 * Why an entered measurement can't be used: text that isn't a number at all, or a negative
 * amount (a weight, size or price below zero is meaningless, and the repository rejects it).
 */
export type MeasureIssue = 'not-a-number' | 'negative';

export interface NumericEntry {
  /** The parsed number, or null for a deliberately blank entry. Never set when `issue` is. */
  readonly value: number | null;
  /** Why the entry is unusable, or null when it is fine (blank included). */
  readonly issue: MeasureIssue | null;
}

/**
 * Parse an optional numeric entry from a text field. Blank means *clear the stored value*
 * (`null`, no issue); anything else must parse to a finite, non-negative number.
 *
 * An unusable entry reports its `issue` and yields no value, so a caller can never mistake
 * "you typed something wrong" for "you cleared the field" — the two used to collapse into the
 * same `null` and silently erased the stored value on save (issue #345).
 */
export function parseOptionalNumber(input: string): NumericEntry {
  if (input.trim() === '') return { value: null, issue: null };
  const parsed = Number(input);
  if (!Number.isFinite(parsed)) return { value: null, issue: 'not-a-number' };
  if (parsed < 0) return { value: null, issue: 'negative' };
  return { value: parsed, issue: null };
}

export interface MeasureDraft {
  /** Whether the entry differs from the canonical display of the stored value. */
  readonly dirty: boolean;
  /** The value to save, in canonical units. Holds the stored value while `issue` is set. */
  readonly value: number | null;
  /** Why the entry can't be saved, or null when it can. */
  readonly issue: MeasureIssue | null;
}

/**
 * Derive one measurement field's draft state from its input string and stored canonical value
 * (grams for a weight, millimetres for a dimension).
 *
 * `dirty` compares the input against the canonical display of the stored value, so the
 * canonical↔display conversion's floating-point noise never marks an untouched field dirty;
 * an untouched field keeps the exact stored value, so saving a *different* field never nudges
 * it via the round-trip. An unusable entry surfaces its `issue` for the caller to render and
 * block the save on, and leaves `value` at the stored value so nothing is erased.
 *
 * @param toCanonical converts an entered amount in the display unit to canonical units.
 * @param toInput renders a stored canonical value as this field's input string.
 */
export function resolveMeasureDraft(
  input: string,
  stored: number | null,
  toCanonical: (entered: number) => number,
  toInput: (stored: number | null) => string,
): MeasureDraft {
  const dirty = input.trim() !== toInput(stored);
  if (!dirty) return { dirty: false, value: stored ?? null, issue: null };
  const { value, issue } = parseOptionalNumber(input);
  if (issue !== null) return { dirty: true, value: stored ?? null, issue };
  return { dirty: true, value: value === null ? null : toCanonical(value), issue: null };
}
