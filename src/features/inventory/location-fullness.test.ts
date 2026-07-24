import { describe, it, expect } from 'vitest';
import {
  isLocationFull,
  isVolumetricFullness,
  locationCapacityVolume,
  locationFullness,
  resolveLocationFullness,
  volumetricFullness,
  type LocationVolumeShape,
  type LocationVolumeTotals,
} from './location-fullness';

/**
 * Test-only fold of raw per-item contents into the {@link LocationVolumeTotals} aggregate the SQL
 * read produces — keeps these cases readable without the production code carrying a second,
 * app-unused aggregation path.
 */
function totals(contents: { volume: number | null; quantity: number }[]): LocationVolumeTotals {
  let usedVolume = 0;
  let measuredUnits = 0;
  let totalUnits = 0;
  let measuredItems = 0;
  let totalItems = 0;
  for (const { volume, quantity } of contents) {
    if (!(quantity > 0)) continue;
    totalUnits += quantity;
    totalItems += 1;
    if (volume != null && volume >= 0) {
      usedVolume += volume * quantity;
      measuredUnits += quantity;
      measuredItems += 1;
    }
  }
  return { usedVolume, measuredUnits, totalUnits, measuredItems, totalItems };
}

describe('locationFullness', () => {
  it('returns null when there is no positive capacity', () => {
    expect(locationFullness(5, null)).toBeNull();
    expect(locationFullness(5, undefined)).toBeNull();
    expect(locationFullness(5, 0)).toBeNull();
    expect(locationFullness(5, -1)).toBeNull();
  });

  it('computes a rounded, clamped percentage', () => {
    expect(locationFullness(0, 10)?.percent).toBe(0);
    expect(locationFullness(5, 10)?.percent).toBe(50);
    expect(locationFullness(1, 3)?.percent).toBe(33);
    // Over capacity saturates the display at 100 but flags `over`.
    expect(locationFullness(15, 10)?.percent).toBe(100);
  });

  it('reports full and over states distinctly', () => {
    expect(locationFullness(9, 10)).toMatchObject({ full: false, over: false });
    expect(locationFullness(10, 10)).toMatchObject({ full: true, over: false });
    expect(locationFullness(11, 10)).toMatchObject({ full: true, over: true });
  });
});

describe('isLocationFull', () => {
  it('is false without a positive capacity', () => {
    expect(isLocationFull(100, null)).toBe(false);
    expect(isLocationFull(100, 0)).toBe(false);
  });

  it('is true when adding would exceed the capacity', () => {
    expect(isLocationFull(9, 10)).toBe(false); // 9 + 1 = 10, still fits
    expect(isLocationFull(10, 10)).toBe(true); // 10 + 1 = 11, over
    expect(isLocationFull(8, 10, 3)).toBe(true); // 8 + 3 = 11, over
  });
});

// ── Volumetric fullness (issue #457) ────────────────────────────────────────
const DIMS = (over: Partial<LocationVolumeShape> = {}): LocationVolumeShape => ({
  width: null,
  height: null,
  depth: null,
  usableVolume: null,
  packingFactor: null,
  ...over,
});

describe('locationCapacityVolume', () => {
  it('derives from W×H×D and applies the global packing factor', () => {
    // 100×100×100 = 1,000,000 mm³ × 0.5 = 500,000.
    expect(locationCapacityVolume(DIMS({ width: 100, height: 100, depth: 100 }), 0.5)).toBe(500_000);
  });

  it('prefers an explicit usable-volume override over the box product', () => {
    const loc = DIMS({ width: 100, height: 100, depth: 100, usableVolume: 200_000 });
    expect(locationCapacityVolume(loc, 1)).toBe(200_000);
  });

  it("uses the location's own packing factor over the global default", () => {
    const loc = DIMS({ width: 100, height: 100, depth: 100, packingFactor: 0.8 });
    expect(locationCapacityVolume(loc, 0.5)).toBe(800_000);
  });

  it('degrades an invalid packing factor to no haircut, and is null without a size', () => {
    const loc = DIMS({ width: 100, height: 100, depth: 100 });
    expect(locationCapacityVolume(loc, 5)).toBe(1_000_000); // >1 → treated as 1
    expect(locationCapacityVolume(DIMS(), 1)).toBeNull();
  });

  it('floors a sub-minimum packing factor rather than collapsing capacity to near-zero', () => {
    // 0.01 is below the 5% floor → clamped to 0.05, so a location can't read as wildly over-full.
    const loc = DIMS({ width: 100, height: 100, depth: 100, packingFactor: 0.01 });
    expect(locationCapacityVolume(loc, 1)).toBe(50_000);
  });
});

describe('volumetricFullness', () => {
  it('sums measured volume × qty and reports full/over against capacity', () => {
    const agg = totals([
      { volume: 100_000, quantity: 4 }, // 400,000
      { volume: 50_000, quantity: 2 }, // 100,000
    ]);
    const vf = volumetricFullness(agg, 1_000_000);
    expect(vf).toMatchObject({ usedVolume: 500_000, percent: 50, full: false, over: false, coverage: 1 });
  });

  it('saturates percent at 100 but flags over, and coverage drops with unmeasured units', () => {
    const agg = totals([
      { volume: 600_000, quantity: 2 }, // 1,200,000 measured
      { volume: null, quantity: 8 }, // 8 unmeasured units drag coverage
    ]);
    const vf = volumetricFullness(agg, 1_000_000)!;
    expect(vf.percent).toBe(100);
    expect(vf.over).toBe(true);
    expect(vf.measuredItems).toBe(1);
    expect(vf.totalItems).toBe(2);
    // measured units 2 of total 10.
    expect(vf.coverage).toBeCloseTo(0.2, 6);
  });

  it('is null without a positive capacity volume', () => {
    expect(volumetricFullness(totals([]), null)).toBeNull();
    expect(volumetricFullness(totals([]), 0)).toBeNull();
  });
});

describe('resolveLocationFullness (the honest-mode ladder)', () => {
  const EMPTY = totals([]);
  it('uses volume mode when there is a capacity volume and a measured item', () => {
    const loc = { ...DIMS({ width: 100, height: 100, depth: 100 }), capacity: 5, itemCount: 3 };
    const fullness = resolveLocationFullness(loc, totals([{ volume: 500_000, quantity: 1 }]), 1);
    expect(fullness && isVolumetricFullness(fullness)).toBe(true);
    expect(fullness?.percent).toBe(50);
  });

  it('falls back to count mode when the location has items but none are measured', () => {
    const loc = { ...DIMS({ width: 100, height: 100, depth: 100 }), capacity: 4, itemCount: 2 };
    const fullness = resolveLocationFullness(loc, totals([{ volume: null, quantity: 2 }]), 1);
    expect(fullness && isVolumetricFullness(fullness)).toBe(false);
    expect(fullness?.percent).toBe(50); // 2 of 4 by count
  });

  it('uses volume mode for a measured but empty location (0%)', () => {
    const loc = { ...DIMS({ width: 100, height: 100, depth: 100 }), capacity: null, itemCount: 0 };
    const fullness = resolveLocationFullness(loc, EMPTY, 1);
    expect(fullness && isVolumetricFullness(fullness)).toBe(true);
    expect(fullness?.percent).toBe(0);
  });

  it('falls back to count mode when there is no measured size', () => {
    const loc = { ...DIMS(), capacity: 10, itemCount: 7 };
    const fullness = resolveLocationFullness(loc, totals([{ volume: null, quantity: 7 }]), 1);
    expect(fullness && isVolumetricFullness(fullness)).toBe(false);
    expect(fullness?.percent).toBe(70);
  });

  it('is null when there is neither a capacity volume nor a count capacity', () => {
    const loc = { ...DIMS(), capacity: null, itemCount: 3 };
    expect(resolveLocationFullness(loc, totals([{ volume: null, quantity: 3 }]), 1)).toBeNull();
  });
});
