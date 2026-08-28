import { beforeEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_DENSITY,
  DEFAULT_GROUPING,
  LAYOUT_DENSITIES,
  normaliseDensity,
  normaliseGrouping,
  useLayoutStore,
} from './useLayoutStore';

const state = () => useLayoutStore.getState();

/**
 * Seed `localStorage` with a persisted payload and replay Zustand's rehydration, which is
 * where an untyped `JSON.parse` result would otherwise reach the store verbatim.
 */
function rehydrateFrom(persisted: unknown): void {
  localStorage.setItem('gubbins:layout', JSON.stringify({ state: persisted, version: 0 }));
  void useLayoutStore.persist.rehydrate();
}

beforeEach(() => {
  localStorage.clear();
  useLayoutStore.setState({
    density: DEFAULT_DENSITY,
    grouping: DEFAULT_GROUPING,
    sidebarCollapsed: false,
    inventoryLocationCard: true,
    dashboardLayout: [],
    navTileOrder: [],
  });
});

describe('normaliseDensity / normaliseGrouping', () => {
  it.each(LAYOUT_DENSITIES)('keeps the live density %s', (density) => {
    expect(normaliseDensity(density)).toBe(density);
  });

  // 'compact' was this list's stand-in for a retired mode until it became a real one (#444);
  // 'ultra-compact' keeps a plausible-but-unknown string in the set, which is the case that
  // matters — a persisted value from a build this one has never heard of.
  it.each([['ultra-compact'], [''], [undefined], [null], [0], [{}], [['visual']]])(
    'falls back to the default for %p',
    (value) => {
      expect(normaliseDensity(value)).toBe(DEFAULT_DENSITY);
    },
  );

  it('reconciles grouping the same way', () => {
    expect(normaliseGrouping('location')).toBe('location');
    expect(normaliseGrouping('category')).toBe(DEFAULT_GROUPING);
  });
});

describe('useLayoutStore — rehydration', () => {
  it('keeps a persisted state that is entirely valid', () => {
    rehydrateFrom({
      density: 'table',
      grouping: 'location',
      sidebarCollapsed: true,
      inventoryLocationCard: false,
    });
    expect(state().density).toBe('table');
    expect(state().grouping).toBe('location');
    expect(state().sidebarCollapsed).toBe(true);
    expect(state().inventoryLocationCard).toBe(false);
  });

  it('replaces a density retired from the union rather than rendering off it', () => {
    // The per-density row-height table is exhaustive over LayoutDensity; an unmatched value
    // would show "Visual" in the menu while the list rendered off a missed lookup.
    rehydrateFrom({ density: 'ultra-compact' });
    expect(state().density).toBe(DEFAULT_DENSITY);
  });

  it('replaces a grouping retired from the union', () => {
    rehydrateFrom({ grouping: 'category' });
    expect(state().grouping).toBe(DEFAULT_GROUPING);
  });

  it('falls back to the defaults when a field is missing entirely', () => {
    rehydrateFrom({ density: 'data' });
    expect(state().density).toBe('data');
    expect(state().grouping).toBe(DEFAULT_GROUPING);
    expect(state().sidebarCollapsed).toBe(false);
    expect(state().inventoryLocationCard).toBe(true);
  });

  it('does not take a non-boolean as a toggle state', () => {
    rehydrateFrom({ sidebarCollapsed: 'true', inventoryLocationCard: 0 });
    expect(state().sidebarCollapsed).toBe(false);
    expect(state().inventoryLocationCard).toBe(true);
  });

  it('replaces a non-array layout with an empty one', () => {
    rehydrateFrom({ dashboardLayout: { widget: 'stats' }, navTileOrder: 'inventory' });
    expect(state().dashboardLayout).toEqual([]);
    expect(state().navTileOrder).toEqual([]);
  });

  it('survives a payload that is not an object at all', () => {
    rehydrateFrom('corrupt');
    expect(state().density).toBe(DEFAULT_DENSITY);
    expect(state().grouping).toBe(DEFAULT_GROUPING);
  });

  it('leaves the store actions intact after rehydrating', () => {
    rehydrateFrom({ density: 'ultra-compact' });
    state().setDensity('map');
    expect(state().density).toBe('map');
  });
});

describe('useLayoutStore — setters', () => {
  it('rejects an out-of-union density handed in at runtime', () => {
    state().setDensity('bogus' as never);
    expect(state().density).toBe(DEFAULT_DENSITY);
  });

  it('toggleDensity still flips between the two per-item extremes', () => {
    state().setDensity('data');
    state().toggleDensity();
    expect(state().density).toBe('visual');
    state().toggleDensity();
    expect(state().density).toBe('data');
  });
});
