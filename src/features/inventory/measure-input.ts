/**
 * Shared measurement-field helpers for editing a canonical-mm dimension in the user's chosen
 * `dimensionUnit` (issue #30, issue #457). Lifted out of `ItemDetailsEditor` so the item editor
 * and the location dialogs share one round-trip-and-clamp implementation rather than duplicating
 * it — the same value must behave identically whether it describes an item or the container it
 * sits in.
 *
 * Both are thin bindings over the unit-agnostic {@link resolveMeasureDraft} seam: `toMm`/`fromMm`
 * supply the canonical↔display conversion, and the trailing-noise trim keeps an untouched field
 * from reading dirty after a unit round-trip.
 */
import { fromMm, toMm, type DimensionUnit } from '@/lib/dimensions';
import { resolveMeasureDraft, type MeasureDraft } from './components/measure-draft';

/**
 * Render a stored canonical-millimetre dimension as an input string in `unit` (blank when unset),
 * with the conversion's floating-point noise trimmed — so `1250 mm` shows as `1.25` in metres,
 * not `1.2500000001`.
 */
export function dimensionToInput(mm: number | null, unit: DimensionUnit): string {
  if (mm == null) return '';
  return String(Number(fromMm(mm, unit).toFixed(6)));
}

/** Derive one dimension field's draft state — {@link resolveMeasureDraft} bound to mm↔unit. */
export function resolveDimension(input: string, stored: number | null, unit: DimensionUnit): MeasureDraft {
  return resolveMeasureDraft(
    input,
    stored,
    (entered) => toMm(entered, unit),
    (mm) => dimensionToInput(mm, unit),
  );
}
