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

/** The length units the user may read/enter dimensions in. Canonical storage is always mm. */
export type DimensionUnit = 'mm' | 'cm' | 'm' | 'in' | 'ft';

/**
 * Every supported unit, for iteration/normalisation (SSOT).
 *
 * @internal Exported for unit tests only.
 */
export const DIMENSION_UNITS = ['mm', 'cm', 'm', 'in', 'ft'] as const satisfies readonly DimensionUnit[];

/**
 * Millimetres per one of each unit — the single conversion table. `toMm`/`fromMm` are defined
 * purely in terms of these factors, so a value round-trips (`fromMm(toMm(v))`) to within
 * floating-point tolerance. The imperial factors are the exact international definitions
 * (1 in = 25.4 mm, 1 ft = 304.8 mm).
 */
const MM_PER_UNIT: Readonly<Record<DimensionUnit, number>> = {
  mm: 1,
  cm: 10,
  m: 1000,
  in: 25.4,
  ft: 304.8,
};

/** The default display/entry unit — millimetres, the canonical storage unit (stored == shown). */
export const DEFAULT_DIMENSION_UNIT: DimensionUnit = 'mm';

/** Choices for the Settings "Dimension unit" control (default listed first). */
export const DIMENSION_UNIT_OPTIONS = [
  { value: 'mm', label: 'Millimetres (mm)' },
  { value: 'cm', label: 'Centimetres (cm)' },
  { value: 'm', label: 'Metres (m)' },
  { value: 'in', label: 'Inches (in)' },
  { value: 'ft', label: 'Feet (ft)' },
] as const satisfies readonly { value: DimensionUnit; label: string }[];

/**
 * Coerce an arbitrary persisted value to a valid {@link DimensionUnit} (default mm). Kept
 * total so a stale localStorage value from an older/newer build can never reach the formatter
 * or a conversion.
 */
export function normaliseDimensionUnit(value: string): DimensionUnit {
  return (DIMENSION_UNITS as readonly string[]).includes(value)
    ? (value as DimensionUnit)
    : DEFAULT_DIMENSION_UNIT;
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
 * → `1.25 m`. Locale-aware grouping/decimal via native `Intl`; up to three fraction digits with
 * trailing zeros trimmed (so `250 mm`, not `250.000 mm`). A non-finite value yields the same `—`
 * placeholder the money/measure/weight formatters use.
 */
export function formatDimension(mm: number, unit: DimensionUnit, locale = 'en-GB'): string {
  if (!Number.isFinite(mm)) return '—';
  const value = fromMm(mm, unit);
  const formatted = new Intl.NumberFormat(locale, { maximumFractionDigits: 3 }).format(value);
  return `${formatted} ${unit}`;
}
