/**
 * Dimension (length) domain — pure unit primitives shared by the formatter, the preferences
 * store and the item editor (issue #30 "intrinsic width / height / depth fields").
 *
 * An item's `width`, `height` and `depth` are each stored **canonically in millimetres** (a
 * single numeric column apiece), so dimensions are directly comparable across items regardless
 * of the unit the user reads them in. The chosen display/entry unit is a Tier-2 preference
 * (`dimensionUnit`), applied at the edges exactly as `locale` / `baseCurrency` / `weightUnit`
 * are: the stored number never changes when the preference changes — only its presentation.
 *
 * Side-effect-free (no React, no DB, no `Intl` singletons held) so the conversions and
 * normalisation are unit-tested in isolation and safe to import from the `lib` layer. Kept
 * free of any `./format` import so the reactive `Formatters` bundle can depend on these
 * conversions without a circular module reference. Mirrors `lib/weight.ts` by design.
 */
import { measurementFormatOptions } from './measurement-format';
import { normaliseOneOf } from './persisted-state';

/**
 * The length units the user may read/enter dimensions in. Canonical storage is always mm.
 *
 * The set spans the range a stored object is actually measured in, from the micrometre (foil,
 * film and shim thickness) up to the yard (fabric, rope and timber), with `thou` as the
 * imperial counterpart of `µm` so a workshop working in thousandths is no worse served than
 * one working in microns. Units far outside the size of a thing kept in a box (kilometres,
 * miles) are deliberately absent — see issue #416.
 */
export type DimensionUnit = 'um' | 'mm' | 'cm' | 'm' | 'thou' | 'in' | 'ft' | 'yd';

/**
 * Every supported unit, for iteration/normalisation (SSOT).
 *
 * @internal Exported for unit tests only.
 */
export const DIMENSION_UNITS = [
  'um',
  'mm',
  'cm',
  'm',
  'thou',
  'in',
  'ft',
  'yd',
] as const satisfies readonly DimensionUnit[];

/**
 * Millimetres per one of each unit — the single conversion table. `toMm`/`fromMm` are defined
 * purely in terms of these factors, so a value round-trips (`fromMm(toMm(v))`) to within
 * floating-point tolerance. Every factor is an *exact* definition, not an approximation: the
 * international inch is 25.4 mm by definition, from which 1 thou = 1/1000 in = 0.0254 mm,
 * 1 ft = 12 in = 304.8 mm and 1 yd = 3 ft = 914.4 mm all follow.
 */
const MM_PER_UNIT: Readonly<Record<DimensionUnit, number>> = {
  um: 0.001,
  mm: 1,
  cm: 10,
  m: 1000,
  thou: 0.0254,
  in: 25.4,
  ft: 304.8,
  yd: 914.4,
};

/**
 * How each unit is written for display, where that differs from its internal code — `um` is
 * an ASCII-safe key for a persisted preference, but a reader expects `µm`. Mirrors the same
 * seam in `lib/volume.ts`, which needs it for its superscripts.
 */
const DIMENSION_UNIT_LABELS: Readonly<Record<DimensionUnit, string>> = {
  um: 'µm',
  mm: 'mm',
  cm: 'cm',
  m: 'm',
  thou: 'thou',
  in: 'in',
  ft: 'ft',
  yd: 'yd',
};

/** How a length unit is written for display (e.g. `'um'` → `'µm'`). */
export function dimensionUnitLabel(unit: DimensionUnit): string {
  return DIMENSION_UNIT_LABELS[unit];
}

/**
 * Which measurement family each length unit belongs to. A `Record` keyed by {@link DimensionUnit}
 * rather than a `unit === 'in' || …` test, so adding a unit is a *compile error* until it is
 * classified — the volume domain derives a user's auto volume units from this
 * (`volumeSystemForDimensionUnit`), and a new imperial unit silently defaulting to metric would
 * hand a yards-and-feet user their storage capacity in litres.
 */
export const DIMENSION_UNIT_SYSTEM: Readonly<Record<DimensionUnit, 'metric' | 'imperial'>> = {
  um: 'metric',
  mm: 'metric',
  cm: 'metric',
  m: 'metric',
  thou: 'imperial',
  in: 'imperial',
  ft: 'imperial',
  yd: 'imperial',
};

/** The default display/entry unit — millimetres, the canonical storage unit (stored == shown). */
export const DEFAULT_DIMENSION_UNIT: DimensionUnit = 'mm';

/**
 * Choices for the Settings "Dimension unit" control — the default first, then the rest of the
 * metric units, then the imperial ones, each group running smallest to largest.
 */
export const DIMENSION_UNIT_OPTIONS = [
  { value: 'mm', label: 'Millimetres (mm)' },
  { value: 'um', label: 'Micrometres (µm)' },
  { value: 'cm', label: 'Centimetres (cm)' },
  { value: 'm', label: 'Metres (m)' },
  { value: 'thou', label: 'Thousandths of an inch (thou)' },
  { value: 'in', label: 'Inches (in)' },
  { value: 'ft', label: 'Feet (ft)' },
  { value: 'yd', label: 'Yards (yd)' },
] as const satisfies readonly { value: DimensionUnit; label: string }[];

/**
 * Coerce an arbitrary persisted value to a valid {@link DimensionUnit} (default mm). Kept
 * total so a stale localStorage value from an older/newer build can never reach the formatter
 * or a conversion.
 */
export function normaliseDimensionUnit(value: unknown): DimensionUnit {
  return normaliseOneOf(value, DIMENSION_UNITS, DEFAULT_DIMENSION_UNIT);
}

/** Convert a value expressed in `unit` to canonical millimetres (for storage). */
export function toMm(value: number, unit: DimensionUnit): number {
  return value * MM_PER_UNIT[unit];
}

/** Convert canonical millimetres to a value expressed in `unit` (for entry/display). */
export function fromMm(mm: number, unit: DimensionUnit): number {
  return mm / MM_PER_UNIT[unit];
}

/**
 * Format a canonical millimetre dimension for display in `unit`, e.g. `formatDimension(1250, 'm')`
 * → `1.25 m`. Locale-aware grouping/decimal via native `Intl`; {@link measurementFormatOptions}
 * decides the precision. A non-finite value yields the same `—` placeholder the money/measure/
 * weight formatters use.
 */
export function formatDimension(mm: number, unit: DimensionUnit, locale = 'en-GB'): string {
  if (!Number.isFinite(mm)) return '—';
  const value = fromMm(mm, unit);
  const formatted = new Intl.NumberFormat(locale, measurementFormatOptions(value)).format(value);
  return `${formatted} ${dimensionUnitLabel(unit)}`;
}
