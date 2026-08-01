import type { TypedTranslator } from '@/features/i18n';
import { assertExhaustive } from '@/lib/exhaustive';

/**
 * Why an entered measurement can't be used: text that isn't a number at all, a negative amount
 * (a weight, size or price below zero is meaningless, and the repository rejects it), or zero
 * where only a count above zero means anything (a depreciation term).
 */
export type MeasureIssue = 'not-a-number' | 'negative' | 'not-positive';

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

/**
 * Parse an optional **whole count above zero** — {@link parseOptionalNumber}'s rule for a field
 * whose column demands more than merely non-negative, currently the depreciation term
 * (`items.depreciation_months > 0`).
 *
 * `0` can't share the "negative" branch: it is a perfectly good weight but a useless life, and
 * letting it through would read as *switch depreciation off* when the user typed a number. A
 * fractional entry truncates towards zero, matching the repository, so `0.5` is reported rather
 * than quietly stored as `0`. Blank still means *clear the stored value*.
 */
export function parseOptionalPositiveInt(input: string): NumericEntry {
  if (input.trim() === '') return { value: null, issue: null };
  const parsed = Number(input);
  if (!Number.isFinite(parsed)) return { value: null, issue: 'not-a-number' };
  const whole = Math.trunc(parsed);
  if (whole <= 0) return { value: null, issue: 'not-positive' };
  return { value: whole, issue: null };
}

/**
 * The copy explaining a rejected entry to whoever typed it, shaped to drop straight into a
 * `FormField`'s `error` (`undefined` when there is nothing wrong).
 *
 * Shared by every editor that parses through this seam, so the same bad entry reads the same way
 * wherever it is typed — a price on the *Details* tab and a price on the *Lifecycle* tab are the
 * same field to a user, and used to disagree about what they would do with `1,250` (issue #675).
 */
export function measureIssueText(issue: MeasureIssue | null, t: TypedTranslator): string | undefined {
  switch (issue) {
    case null:
      return undefined;
    case 'negative':
      return t('inventory.details.negative');
    case 'not-positive':
      return t('inventory.details.notPositive');
    case 'not-a-number':
      return t('inventory.details.notANumber');
    default:
      assertExhaustive(issue);
      // An out-of-band issue is still an unusable entry: say the general thing rather than
      // rendering nothing, which would read as "this saved fine".
      return t('inventory.details.notANumber');
  }
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
