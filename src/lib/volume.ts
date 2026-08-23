/**
 * Volume domain — pure unit primitives for a location's internal capacity (issue #457),
 * the volume counterpart to {@link import('./dimensions')} and modelled on it deliberately.
 *
 * A location's derived volume comes from its `width × height × depth`, each stored canonically
 * in **millimetres**, so the natural canonical volume unit is the **cubic millimetre** (mm³).
 * mm³ is unreadable at human scale (a 30 cm drawer is 27,000,000 mm³), so — unlike a length —
 * volume needs its own presentation seam: a Tier-2 `volumeUnit` preference applied only at the
 * edges, defaulting to `'auto'`, which picks a human-scaled unit per value.
 *
 * Side-effect-free (no React, no DB, no `Intl` singletons held) and kept free of any
 * `./format` import so the reactive `Formatters` bundle can depend on these conversions without
 * a circular module reference — exactly the discipline `lib/dimensions.ts` follows.
 */
import { type DimensionUnit } from './dimensions';
import { normaliseOneOf } from './persisted-state';

/** The volume units the user may read volumes in. Canonical storage is always mm³. */
export type VolumeUnit = 'mm3' | 'cm3' | 'l' | 'm3' | 'in3' | 'ft3';

/**
 * The stored `volumeUnit` preference: a fixed {@link VolumeUnit}, or `'auto'` to derive a
 * readable unit per value from the user's `dimensionUnit` (metric vs imperial) via
 * {@link autoVolumeUnit}. `'auto'` is the default so nothing renders as `0.0000027 m³`.
 */
export type VolumeUnitPreference = 'auto' | VolumeUnit;

/**
 * Every fixed volume unit, for iteration/normalisation (SSOT).
 *
 * @internal Exported for unit tests only.
 */
export const VOLUME_UNITS = ['mm3', 'cm3', 'l', 'm3', 'in3', 'ft3'] as const satisfies readonly VolumeUnit[];

/**
 * Cubic millimetres per one of each unit — the single conversion table. `toMm3`/`fromMm3` are
 * defined purely in terms of these factors, so a value round-trips (`fromMm3(toMm3(v))`) to
 * within floating-point tolerance. The metric factors are exact powers of ten (1 cm³ = 1000 mm³,
 * 1 L = 1e6 mm³, 1 m³ = 1e9 mm³); the imperial factors follow from the exact inch definition
 * (25.4 mm)³ = 16387.064 mm³ and (304.8 mm)³ = 28316846.592 mm³.
 */
const MM3_PER_UNIT: Readonly<Record<VolumeUnit, number>> = {
  mm3: 1,
  cm3: 1_000,
  l: 1_000_000,
  m3: 1_000_000_000,
  in3: 16_387.064,
  ft3: 28_316_846.592,
};

/** How each unit is written for display — the superscript/label forms of the internal codes. */
const VOLUME_UNIT_LABELS: Readonly<Record<VolumeUnit, string>> = {
  mm3: 'mm³',
  cm3: 'cm³',
  l: 'L',
  m3: 'm³',
  in3: 'in³',
  ft3: 'ft³',
};

/** How a volume unit is written for display (e.g. `'l'` → `'L'`, `'m3'` → `'m³'`). */
export function volumeUnitLabel(unit: VolumeUnit): string {
  return VOLUME_UNIT_LABELS[unit];
}

/** The default `volumeUnit` preference — derive a readable unit per value from the length unit. */
export const DEFAULT_VOLUME_UNIT: VolumeUnitPreference = 'auto';

/**
 * Packing efficiency — the fraction of a location's raw usable volume that is realistically
 * fillable (issue #457). Lives here (the shared, dependency-free volume domain) so the *same*
 * bounds are enforced everywhere a packing factor is set or applied: the global-default
 * preference, the per-location entry field, the repository normaliser, and the cube-utilisation
 * maths. Before this was split out, only the global default was floored, so a per-location value
 * could slip below the floor and collapse a location's effective capacity to near-zero.
 *
 * The default is `1.0` (no haircut — trust the raw volume; opt into a haircut rather than
 * imposing one). The floor is a small non-zero value rather than 0 so a stale/typo'd value can
 * never make a measured location read as wildly over-full. Decimals are kept (0.7 is meaningful).
 */
export const DEFAULT_PACKING_FACTOR = 1;
export const PACKING_FACTOR_BOUNDS = { min: 0.05, max: 1 } as const;

/** Clamp a packing factor to {@link PACKING_FACTOR_BOUNDS}; non-finite falls back to the default. */
export function clampPackingFactor(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return DEFAULT_PACKING_FACTOR;
  return Math.min(PACKING_FACTOR_BOUNDS.max, Math.max(PACKING_FACTOR_BOUNDS.min, value));
}

/** Choices for the Settings "Volume unit" control (Automatic listed first, then largest→smallest). */
export const VOLUME_UNIT_OPTIONS = [
  { value: 'auto', label: 'Automatic (match dimension unit)' },
  { value: 'l', label: 'Litres (L)' },
  { value: 'cm3', label: 'Cubic centimetres (cm³)' },
  { value: 'm3', label: 'Cubic metres (m³)' },
  { value: 'mm3', label: 'Cubic millimetres (mm³)' },
  { value: 'in3', label: 'Cubic inches (in³)' },
  { value: 'ft3', label: 'Cubic feet (ft³)' },
] as const satisfies readonly { value: VolumeUnitPreference; label: string }[];

/**
 * Coerce an arbitrary persisted value to a valid {@link VolumeUnitPreference} (default
 * `'auto'`). Kept total so a stale localStorage value from an older/newer build can never
 * reach the formatter or a conversion — mirrors `normaliseDimensionUnit`.
 */
export function normaliseVolumeUnit(value: unknown): VolumeUnitPreference {
  if (value === 'auto') return 'auto';
  return normaliseOneOf(value, VOLUME_UNITS, DEFAULT_VOLUME_UNIT);
}

/** Convert a value expressed in `unit` to canonical cubic millimetres (for storage). */
export function toMm3(value: number, unit: VolumeUnit): number {
  return value * MM3_PER_UNIT[unit];
}

/** Convert canonical cubic millimetres to a value expressed in `unit` (for entry/display). */
export function fromMm3(mm3: number, unit: VolumeUnit): number {
  return mm3 / MM3_PER_UNIT[unit];
}

/**
 * Derive a bounding-box volume in canonical mm³ from three canonical-mm dimensions, or `null`
 * unless **all three** are present and finite — a partially-measured container has no honest
 * volume. A non-finite or negative input likewise yields `null` (the repository's CHECK keeps
 * stored dimensions non-negative, but this stays total for any caller).
 */
export function volumeFromDimensions(
  width: number | null,
  height: number | null,
  depth: number | null,
): number | null {
  if (width == null || height == null || depth == null) return null;
  if (!Number.isFinite(width) || !Number.isFinite(height) || !Number.isFinite(depth)) return null;
  if (width < 0 || height < 0 || depth < 0) return null;
  return width * height * depth;
}

/** Whether a length unit belongs to the metric or the imperial family (drives auto volume units). */
export function volumeSystemForDimensionUnit(unit: DimensionUnit): 'metric' | 'imperial' {
  return unit === 'in' || unit === 'ft' ? 'imperial' : 'metric';
}

/**
 * Pick a human-scaled unit for a canonical-mm³ volume so nothing renders as `0.0000027 m³` or
 * `27000000 mm³`. Metric climbs mm³ → cm³ → litres → m³ (litres for anything drawer-to-crate
 * sized); imperial uses in³ up to a cubic foot, then ft³. A non-finite/negative value falls
 * back to the family's small unit.
 */
export function autoVolumeUnit(mm3: number, system: 'metric' | 'imperial'): VolumeUnit {
  if (system === 'imperial') {
    if (!Number.isFinite(mm3) || mm3 < MM3_PER_UNIT.ft3) return 'in3';
    return 'ft3';
  }
  if (!Number.isFinite(mm3) || mm3 < MM3_PER_UNIT.cm3) return 'mm3';
  if (mm3 < MM3_PER_UNIT.l) return 'cm3';
  if (mm3 < MM3_PER_UNIT.m3) return 'l';
  return 'm3';
}

/**
 * Resolve a {@link VolumeUnitPreference} to a concrete {@link VolumeUnit} for a given value:
 * a fixed unit is returned as-is; `'auto'` derives one adaptively from the value and the user's
 * `dimensionUnit`. The per-value resolution is why `volume(mm3)` re-resolves for each render.
 */
export function resolveVolumeUnit(
  preference: VolumeUnitPreference,
  mm3: number,
  dimensionUnit: DimensionUnit,
): VolumeUnit {
  if (preference !== 'auto') return preference;
  return autoVolumeUnit(mm3, volumeSystemForDimensionUnit(dimensionUnit));
}

/**
 * Format a canonical mm³ volume for display in `unit`, e.g. `formatVolume(12_500_000, 'l')`
 * → `12.5 L`. Locale-aware grouping/decimal via native `Intl`; up to two fraction digits with
 * trailing zeros trimmed (so `27 L`, not `27.00 L`). A non-finite value yields the same `—`
 * placeholder the money/dimension/weight formatters use.
 */
export function formatVolume(mm3: number, unit: VolumeUnit, locale = 'en-GB'): string {
  if (!Number.isFinite(mm3)) return '—';
  const value = fromMm3(mm3, unit);
  const formatted = new Intl.NumberFormat(locale, { maximumFractionDigits: 2 }).format(value);
  return `${formatted} ${VOLUME_UNIT_LABELS[unit]}`;
}

/**
 * The **raw** (pre-packing-factor) usable volume of a container in canonical mm³, or `null`
 * when it has no measured internal size: an explicit `usableVolume` override when one is set,
 * else the W×H×D product. A non-positive figure from either source is `null` — a container with
 * no positive internal volume has no volumetric reading at all.
 *
 * The single definition of "is this container measured?", shared by the fullness resolver
 * (which scales this by the packing factor) and by `LocationRepository`, whose volume-totals
 * aggregate is computed only for the locations this returns a volume for. The two must agree:
 * were the SQL predicate to drift from this, a location would either render a bar from totals
 * that were never computed, or aggregate stock no reader can use.
 */
export function rawContainerVolume(
  usableVolume: number | null,
  width: number | null,
  height: number | null,
  depth: number | null,
): number | null {
  const raw = usableVolume ?? volumeFromDimensions(width, height, depth);
  return raw != null && Number.isFinite(raw) && raw > 0 ? raw : null;
}
