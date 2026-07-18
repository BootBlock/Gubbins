import { describe, expect, it } from 'vitest';
import type { ReorderDefaults, ReorderItem } from './reorder-policy';
import { resolveSupplyState } from './supply-state';

/** Global fallbacks off (0) — the shipped default, so low-stock is purely per-item opt-in. */
const OFF: ReorderDefaults = { qtyThreshold: 0, gaugePercent: 0 };
/** Global fallbacks on, to exercise the COALESCE(per-item, global) path. */
const ON: ReorderDefaults = { qtyThreshold: 5, gaugePercent: 20 };

function discrete(over: Partial<ReorderItem> = {}): ReorderItem {
  return {
    trackingMode: 'DISCRETE',
    quantity: 10,
    gauge: null,
    reorderPoint: null,
    reorderGaugePercent: null,
    reorderQty: null,
    isUnlimited: false,
    ...over,
  } as ReorderItem;
}

function gauge(percentageRemaining: number, over: Partial<ReorderItem> = {}): ReorderItem {
  return discrete({
    trackingMode: 'CONSUMABLE_GAUGE',
    gauge: { grossCapacity: 100, percentageRemaining },
    ...over,
  } as Partial<ReorderItem>);
}

describe('resolveSupplyState', () => {
  it('reports a comfortably-stocked item as stocked, suggesting nothing', () => {
    const resolved = resolveSupplyState({ item: discrete({ quantity: 50 }), defaults: ON, onOrderQty: 0 });
    expect(resolved).toEqual({ state: 'stocked', onOrderQty: 0, suggestedQty: 0, covered: false });
  });

  it('reports an item at its own reorder point as needing ordering', () => {
    const item = discrete({ quantity: 3, reorderPoint: 3 });
    const resolved = resolveSupplyState({ item, defaults: OFF, onOrderQty: 0 });
    expect(resolved.state).toBe('needs-ordering');
  });

  it('suggests the shortfall back up to the reorder point', () => {
    const item = discrete({ quantity: 2, reorderPoint: 10 });
    expect(resolveSupplyState({ item, defaults: OFF, onOrderQty: 0 }).suggestedQty).toBe(8);
  });

  it("prefers the item's explicit reorder quantity over the computed shortfall", () => {
    const item = discrete({ quantity: 2, reorderPoint: 10, reorderQty: 25 });
    expect(resolveSupplyState({ item, defaults: OFF, onOrderQty: 0 }).suggestedQty).toBe(25);
  });

  // The precedence rule the seam exists to state: already-ordered outranks needs-ordering.
  it('reports a low item with stock inbound as on-order, not needs-ordering', () => {
    const item = discrete({ quantity: 1, reorderPoint: 10 });
    const resolved = resolveSupplyState({ item, defaults: OFF, onOrderQty: 12 });
    expect(resolved.state).toBe('on-order');
    expect(resolved.onOrderQty).toBe(12);
  });

  it('keeps the suggested top-up visible while on order, so a short order is still legible', () => {
    const item = discrete({ quantity: 1, reorderPoint: 10 });
    // 3 inbound against a suggested 9 — on order, but not enough to clear the shortfall.
    expect(resolveSupplyState({ item, defaults: OFF, onOrderQty: 3 }).suggestedQty).toBe(9);
  });

  it('reports a fully-stocked item with an inbound order as on-order', () => {
    const resolved = resolveSupplyState({ item: discrete({ quantity: 50 }), defaults: ON, onOrderQty: 4 });
    expect(resolved).toEqual({ state: 'on-order', onOrderQty: 4, suggestedQty: 0, covered: false });
  });

  describe('out of stock', () => {
    // Not opt-in: zero on hand needs ordering whether or not a reorder point was configured.
    it('flags a depleted item with no reorder point configured', () => {
      const resolved = resolveSupplyState({ item: discrete({ quantity: 0 }), defaults: OFF, onOrderQty: 0 });
      expect(resolved.state).toBe('needs-ordering');
      // Nothing to top up *to*, so no quantity is suggested.
      expect(resolved.suggestedQty).toBe(0);
    });

    it('flags an empty gauge', () => {
      expect(resolveSupplyState({ item: gauge(0), defaults: OFF, onOrderQty: 0 }).state).toBe(
        'needs-ordering',
      );
    });

    it('never flags a serialised or untracked item, which hold no bulk stock level', () => {
      for (const trackingMode of ['SERIALISED', 'UNTRACKED'] as const) {
        const item = discrete({ trackingMode, quantity: 0 });
        expect(resolveSupplyState({ item, defaults: ON, onOrderQty: 0 }).state).toBe('stocked');
      }
    });

    it('never flags an unlimited-supply item, however low its stored quantity', () => {
      const item = discrete({ quantity: 0, isUnlimited: true, reorderPoint: 10 });
      expect(resolveSupplyState({ item, defaults: ON, onOrderQty: 0 }).state).toBe('stocked');
    });
  });

  describe('gauge items', () => {
    it('flags a gauge at or below its own percentage floor', () => {
      const item = gauge(15, { reorderGaugePercent: 20 });
      expect(resolveSupplyState({ item, defaults: OFF, onOrderQty: 0 }).state).toBe('needs-ordering');
    });

    it('falls back to the global gauge floor when the item sets none', () => {
      expect(resolveSupplyState({ item: gauge(15), defaults: ON, onOrderQty: 0 }).state).toBe(
        'needs-ordering',
      );
      expect(resolveSupplyState({ item: gauge(15), defaults: OFF, onOrderQty: 0 }).state).toBe('stocked');
    });

    it('suggests no countable top-up for a continuous measure', () => {
      const item = gauge(5, { reorderGaugePercent: 20 });
      expect(resolveSupplyState({ item, defaults: OFF, onOrderQty: 0 }).suggestedQty).toBe(0);
    });
  });

  describe('covered', () => {
    it('is true once enough is inbound to clear the suggested top-up', () => {
      const item = discrete({ quantity: 1, reorderPoint: 10 }); // suggests 9
      expect(resolveSupplyState({ item, defaults: OFF, onOrderQty: 9 }).covered).toBe(true);
      expect(resolveSupplyState({ item, defaults: OFF, onOrderQty: 20 }).covered).toBe(true);
    });

    it('is false while the inbound order falls short of the top-up', () => {
      const item = discrete({ quantity: 1, reorderPoint: 10 }); // suggests 9
      expect(resolveSupplyState({ item, defaults: OFF, onOrderQty: 8 }).covered).toBe(false);
    });

    // Nothing suggested means there is no shortfall to cover — an inbound order on a
    // healthy item is not "covering" anything.
    it('is false when no top-up is suggested', () => {
      const item = discrete({ quantity: 50 });
      expect(resolveSupplyState({ item, defaults: ON, onOrderQty: 5 }).covered).toBe(false);
    });

    it('is false when nothing is inbound', () => {
      const item = discrete({ quantity: 1, reorderPoint: 10 });
      expect(resolveSupplyState({ item, defaults: OFF, onOrderQty: 0 }).covered).toBe(false);
    });
  });

  describe('on-order quantity guarding', () => {
    // Callers pass 0 when purchase orders are off or the read is still pending; a negative or
    // non-finite value can only be a bug upstream, and must not invent an inbound order.
    it.each([0, -5, Number.NaN, Number.POSITIVE_INFINITY])(
      'treats %s inbound as nothing inbound',
      (onOrderQty) => {
        const item = discrete({ quantity: 1, reorderPoint: 10 });
        const resolved = resolveSupplyState({ item, defaults: OFF, onOrderQty });
        expect(resolved.state).toBe('needs-ordering');
        expect(resolved.onOrderQty).toBe(0);
      },
    );
  });
});
