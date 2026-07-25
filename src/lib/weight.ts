/**
 * Weight (mass) domain — pure unit primitives shared by the formatter, the preferences
 * store and the item editor (issue #25 "intrinsic weight field").
 *
 * An item's `weight` is stored **canonically in grams** (a single numeric column), so
 * weights are directly comparable and summable across items regardless of the unit the
 * user reads them in. The chosen display/entry unit is a Tier-2 preference
 * (`weightUnit`), applied at the edges exactly as `locale` / `baseCurrency` are: the
 * stored number never changes when the preference changes — only its presentation.
 *
 * Side-effect-free (no React, no DB, no `Intl` singletons held) so the conversions and
 * normalisation are unit-tested in isolation and safe to import from the `lib` layer.
 * Kept free of any `./format` import so the reactive `Formatters` bundle can depend on
 * these conversions without a circular module reference.
 */
import { normaliseOneOf } from './persisted-state';

/** The weight units the user may read/enter weights in. Canonical storage is always grams. */
export type WeightUnit = 'g' | 'kg' | 'oz' | 'lb';

/** Every supported unit, for iteration/normalisation (SSOT). */
export const WEIGHT_UNITS = ['g', 'kg', 'oz', 'lb'] as const satisfies readonly WeightUnit[];

/**
 * Grams per one of each unit — the single conversion table. `toGrams`/`fromGrams` are
 * defined purely in terms of these factors, so a value round-trips (`fromGrams(toGrams(v))`)
 * to within floating-point tolerance. The imperial factors are the exact international
 * definitions (1 oz = 28.349523125 g, 1 lb = 453.59237 g).
 */
const GRAMS_PER_UNIT: Readonly<Record<WeightUnit, number>> = {
  g: 1,
  kg: 1000,
  oz: 28.349523125,
  lb: 453.59237,
};

/** The default display/entry unit — grams, the canonical storage unit (stored == shown). */
export const DEFAULT_WEIGHT_UNIT: WeightUnit = 'g';

/** Choices for the Settings "Weight unit" control (default listed first). */
export const WEIGHT_UNIT_OPTIONS = [
  { value: 'g', label: 'Grams (g)' },
  { value: 'kg', label: 'Kilograms (kg)' },
  { value: 'oz', label: 'Ounces (oz)' },
  { value: 'lb', label: 'Pounds (lb)' },
] as const satisfies readonly { value: WeightUnit; label: string }[];

/**
 * Coerce an arbitrary persisted value to a valid {@link WeightUnit} (default grams). Kept
 * total so a stale localStorage value from an older/newer build can never reach the
 * formatter or a conversion.
 */
export function normaliseWeightUnit(value: unknown): WeightUnit {
  return normaliseOneOf(value, WEIGHT_UNITS, DEFAULT_WEIGHT_UNIT);
}

/** Convert a value expressed in `unit` to canonical grams (for storage). */
export function toGrams(value: number, unit: WeightUnit): number {
  return value * GRAMS_PER_UNIT[unit];
}

/** Convert canonical grams to a value expressed in `unit` (for entry/display). */
export function fromGrams(grams: number, unit: WeightUnit): number {
  return grams / GRAMS_PER_UNIT[unit];
}

/**
 * Format a canonical gram weight for display in `unit`, e.g. `formatWeight(1250, 'kg')`
 * → `1.25 kg`. Locale-aware grouping/decimal via native `Intl`; up to three fraction
 * digits with trailing zeros trimmed (so `250 g`, not `250.000 g`). A non-finite weight
 * yields the same `—` placeholder the money/measure formatters use.
 */
export function formatWeight(grams: number, unit: WeightUnit, locale = 'en-GB'): string {
  if (!Number.isFinite(grams)) return '—';
  const value = fromGrams(grams, unit);
  const formatted = new Intl.NumberFormat(locale, { maximumFractionDigits: 3 }).format(value);
  return `${formatted} ${unit}`;
}
