/**
 * Location fullness — the pure seam behind the capacity gauge (Edit dialog), the subtle
 * fill bar on tree rows, and the "location is full" warning when adding/moving an item.
 *
 * A location without a capacity (null, or a non-positive one) has no notion of fullness, so
 * the helpers return `null` / `false` for it. `percent` is rounded and clamped to 0–100 for
 * display; `over` reports the true over-capacity state (which `percent` alone would hide once
 * it saturates at 100).
 *
 * Two fullness modes share the {@link Fullness} shape so one bar component renders either:
 * the original **count** mode (`itemCount` vs `capacity`), and the **volumetric** mode
 * (issue #457) — space consumed vs a location's usable internal volume. {@link resolveLocationFullness}
 * picks the honest one per location; everything here is pure and unit-tested.
 */
import type { LocationVolumeTotals } from '@/db/repositories';
import { DEFAULT_PACKING_FACTOR, PACKING_FACTOR_BOUNDS, rawContainerVolume } from '@/lib/volume';

export type { LocationVolumeTotals };

export interface Fullness {
  /** Rounded, clamped 0–100 for the bar width / label. */
  readonly percent: number;
  /** True when the item count meets or exceeds the capacity (the location is full). */
  readonly full: boolean;
  /** True when the item count strictly exceeds the capacity (over the limit). */
  readonly over: boolean;
}

/**
 * A volumetric fullness reading (issue #457): the same bar as count mode, plus the figures a
 * caption needs so the number is never read as exact. `usedVolume` sums only *measured*
 * contents, so `coverage` (unit-weighted) tells the reader how much of what's actually here the
 * bar accounts for — a half-measured location never looks deceptively empty.
 */
export interface VolumetricFullness extends Fullness {
  /** Σ (item volume × units-of-that-item-held-here), canonical mm³ — measured items only. */
  readonly usedVolume: number;
  /** Effective usable volume after the packing factor, canonical mm³. */
  readonly capacityVolume: number;
  /** 0–1: share of on-hand *units here* whose item volume is known. */
  readonly coverage: number;
  /** Distinct items here with all three dimensions (for the "N of M items" caption). */
  readonly measuredItems: number;
  /** Distinct items present here (for the caption). */
  readonly totalItems: number;
}

/** Narrow a {@link Fullness} to a {@link VolumetricFullness} (for rendering the coverage caption). */
export function isVolumetricFullness(fullness: Fullness): fullness is VolumetricFullness {
  return 'capacityVolume' in fullness;
}

/** The dimension/volume fields a location contributes to its effective capacity volume. */
export interface LocationVolumeShape {
  readonly width: number | null;
  readonly height: number | null;
  readonly depth: number | null;
  /** Explicit usable-volume override (mm³); wins over the W×H×D product when set. */
  readonly usableVolume: number | null;
  /** Per-location packing fraction `0 < f ≤ 1`; null defers to the global default. */
  readonly packingFactor: number | null;
}

/** An empty aggregate — a location that holds nothing (or whose totals row is absent). */
export const EMPTY_VOLUME_TOTALS: LocationVolumeTotals = {
  usedVolume: 0,
  measuredUnits: 0,
  totalUnits: 0,
  measuredItems: 0,
  totalItems: 0,
};

/**
 * Clamp a packing fraction to the safe `[min, 1]` range (issue #457), falling back to 1 (no
 * haircut) for anything non-finite or non-positive. Applying the **same floor** the global
 * default and the per-location entry field use means a stray sub-floor value from any source can
 * never collapse a location's effective capacity to near-zero here.
 */
function safePackingFactor(factor: number): number {
  if (!Number.isFinite(factor) || factor <= 0) return DEFAULT_PACKING_FACTOR; // no haircut
  return Math.min(PACKING_FACTOR_BOUNDS.max, Math.max(PACKING_FACTOR_BOUNDS.min, factor));
}

/**
 * A location's **effective** usable volume (mm³), or null when it has no measured internal
 * size: `(usableVolume ?? width·height·depth) × packingFactor`, where the packing factor is the
 * location's own override, else the global default. The raw volume must be positive; the factor
 * is clamped to the safe `[min, 1]` range (a stale/bad value degrades to "no haircut" rather than
 * skewing the maths).
 */
export function locationCapacityVolume(loc: LocationVolumeShape, globalPackingFactor: number): number | null {
  const raw = rawContainerVolume(loc.usableVolume, loc.width, loc.height, loc.depth);
  if (raw == null) return null;
  return raw * safePackingFactor(loc.packingFactor ?? globalPackingFactor);
}

/**
 * Volumetric fullness from a location's aggregated contents and effective capacity volume, or
 * null when there is no capacity volume. `coverage` is unit-weighted (measured units ÷ total
 * units here), so one unmeasured but high-quantity item drags it down honestly. `percent` clamps
 * 0–100 and `over` reports the true overflow, exactly as the count version does.
 */
export function volumetricFullness(
  totals: LocationVolumeTotals,
  capacityVolume: number | null,
): VolumetricFullness | null {
  if (capacityVolume == null || !Number.isFinite(capacityVolume) || capacityVolume <= 0) return null;
  const usedVolume = Number.isFinite(totals.usedVolume) && totals.usedVolume > 0 ? totals.usedVolume : 0;
  const ratio = usedVolume / capacityVolume;
  return {
    percent: Math.min(100, Math.max(0, Math.round(ratio * 100))),
    full: usedVolume >= capacityVolume,
    over: usedVolume > capacityVolume,
    usedVolume,
    capacityVolume,
    coverage: totals.totalUnits > 0 ? totals.measuredUnits / totals.totalUnits : 0,
    measuredItems: totals.measuredItems,
    totalItems: totals.totalItems,
  };
}

/**
 * Pick the honest fullness mode for a location (issue #457), descending a ladder:
 *
 * 1. **Volume mode** — the location has an effective capacity volume *and* either holds nothing
 *    or has at least one measured item. (A location with contents but *zero* measured items
 *    would render a misleading 0%, so it falls through to count mode instead — we can't claim
 *    to know how full it is by volume.)
 * 2. **Count mode** — the existing `itemCount` vs `capacity` gauge.
 * 3. **null** — no notion of fullness at all.
 */
export function resolveLocationFullness(
  location: LocationVolumeShape & { readonly capacity: number | null; readonly itemCount: number },
  totals: LocationVolumeTotals,
  globalPackingFactor: number,
): Fullness | null {
  const capacityVolume = locationCapacityVolume(location, globalPackingFactor);
  if (capacityVolume != null) {
    const vf = volumetricFullness(totals, capacityVolume);
    if (vf != null && (vf.totalItems === 0 || vf.measuredItems >= 1)) return vf;
  }
  return locationFullness(location.itemCount, location.capacity);
}

/** Fullness of a location, or `null` when it has no (positive) capacity limit. */
export function locationFullness(itemCount: number, capacity: number | null | undefined): Fullness | null {
  if (capacity == null || !Number.isFinite(capacity) || capacity <= 0) return null;
  const ratio = itemCount / capacity;
  return {
    percent: Math.min(100, Math.max(0, Math.round(ratio * 100))),
    full: itemCount >= capacity,
    over: itemCount > capacity,
  };
}

/** Would adding `adding` item(s) meet or exceed the location's capacity? */
export function isLocationFull(itemCount: number, capacity: number | null | undefined, adding = 1): boolean {
  if (capacity == null || !Number.isFinite(capacity) || capacity <= 0) return false;
  return itemCount + adding > capacity;
}
