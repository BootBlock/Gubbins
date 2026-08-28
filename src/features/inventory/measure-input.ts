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
import { trimMeasureNoise } from '@/lib/measurement-format';
import { fromMm3, PACKING_FACTOR_BOUNDS, toMm3, type VolumeUnit } from '@/lib/volume';
import { resolveMeasureDraft, type MeasureDraft } from './components/measure-draft';

/** The valid packing-efficiency range as whole percentages (e.g. 5–100). */
export const PACKING_PERCENT_MIN = Math.round(PACKING_FACTOR_BOUNDS.min * 100);
export const PACKING_PERCENT_MAX = Math.round(PACKING_FACTOR_BOUNDS.max * 100);

/**
 * Render a stored canonical-millimetre dimension as an input string in `unit` (blank when unset),
 * with the conversion's floating-point noise trimmed — so `1250 mm` shows as `1.25` in metres,
 * not `1.2500000001`.
 */
export function dimensionToInput(mm: number | null, unit: DimensionUnit): string {
  if (mm == null) return '';
  return trimMeasureNoise(fromMm(mm, unit));
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

/**
 * Render a stored canonical-mm³ volume as an input string in `unit` (blank when unset), with the
 * conversion's floating-point noise trimmed — the volume counterpart to {@link dimensionToInput},
 * for the optional usable-volume override (issue #457).
 */
export function volumeToInput(mm3: number | null, unit: VolumeUnit): string {
  if (mm3 == null) return '';
  return trimMeasureNoise(fromMm3(mm3, unit));
}

/** Derive the usable-volume field's draft state — {@link resolveMeasureDraft} bound to mm³↔unit. */
export function resolveVolume(input: string, stored: number | null, unit: VolumeUnit): MeasureDraft {
  return resolveMeasureDraft(
    input,
    stored,
    (entered) => toMm3(entered, unit),
    (mm3) => volumeToInput(mm3, unit),
  );
}

export interface PackingDraft {
  /** Whether the entry differs from the canonical display of the stored fraction. */
  readonly dirty: boolean;
  /** The value to save, a fraction in `(0, 1]` or null; holds the stored value while out of range. */
  readonly value: number | null;
  /** True when the entry is a number outside 1–100. */
  readonly outOfRange: boolean;
}

/**
 * Derive the packing-efficiency field's draft state (issue #457). Entered as a **percentage**
 * in {@link PACKING_PERCENT_MIN}–{@link PACKING_PERCENT_MAX}, stored as a fraction; blank clears it
 * (defer to the global default). A number outside that range blocks the save and keeps the stored
 * value rather than clearing it — the same clear-vs-error discipline the measurement fields use,
 * and the **same floor** the global default is clamped to, so a per-location value can't slip
 * below it and crater a location's effective capacity. Compares against the stored value's
 * whole-percent display so an untouched field never re-saves via the round-trip.
 */
export function resolvePackingPercent(input: string, stored: number | null): PackingDraft {
  const initial = stored != null ? String(Math.round(stored * 100)) : '';
  const dirty = input.trim() !== initial;
  if (!dirty) return { dirty: false, value: stored, outOfRange: false };
  const trimmed = input.trim();
  if (trimmed === '') return { dirty: true, value: null, outOfRange: false };
  const n = Number(trimmed);
  if (!Number.isFinite(n) || n < PACKING_PERCENT_MIN || n > PACKING_PERCENT_MAX) {
    return { dirty: true, value: stored, outOfRange: true };
  }
  return { dirty: true, value: n / 100, outOfRange: false };
}
