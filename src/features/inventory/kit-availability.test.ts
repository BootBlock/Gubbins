import { describe, it, expect } from 'vitest';
import { buildableCount, planAssembly, rollUpBuildable, type KitTreeNode } from './kit-availability';

/**
 * Kits v1 — the pure "how many whole kits can I build?" maths. The buildable count is the
 * minimum, over every component, of `floor(stock / qtyPerKit)`; the result also names the
 * scarcest component(s) that pin it. Fully dependency-free, so it is exercised exhaustively
 * here in isolation from the repository and UI.
 */
describe('buildableCount', () => {
  it('takes the minimum over components of floor(stock / qtyPerKit)', () => {
    // bandages: 10/2 = 5, scissors: 3/1 = 3, plasters: 20/5 = 4 → min 3.
    const result = buildableCount([
      { name: 'bandage', quantity: 2, stock: 10 },
      { name: 'scissors', quantity: 1, stock: 3 },
      { name: 'plaster', quantity: 5, stock: 20 },
    ]);
    expect(result.count).toBe(3);
    expect(result.limiting.map((c) => c.name)).toEqual(['scissors']);
  });

  it('reports every component tied for the limiting minimum', () => {
    const result = buildableCount([
      { name: 'a', quantity: 1, stock: 2 },
      { name: 'b', quantity: 2, stock: 4 },
      { name: 'c', quantity: 1, stock: 5 },
    ]);
    // a: 2, b: 2, c: 5 → min 2, tied between a and b.
    expect(result.count).toBe(2);
    expect(result.limiting.map((c) => c.name)).toEqual(['a', 'b']);
  });

  it('is 0 when any component has no stock, naming the missing one', () => {
    const result = buildableCount([
      { name: 'have', quantity: 1, stock: 100 },
      { name: 'missing', quantity: 1, stock: 0 },
    ]);
    expect(result.count).toBe(0);
    expect(result.limiting.map((c) => c.name)).toEqual(['missing']);
  });

  it('is 0 with no limiting components for an empty kit', () => {
    expect(buildableCount([])).toEqual({ count: 0, limiting: [] });
  });

  it('rounds down partial coverage', () => {
    // 7 units, 2 per kit → 3 whole kits (one unit spare).
    const result = buildableCount([{ name: 'x', quantity: 2, stock: 7 }]);
    expect(result.count).toBe(3);
  });

  it('ignores a non-positive quantity rather than dividing by zero', () => {
    // A qty of 0 could never come from the DB (a CHECK forbids it), but the maths must not
    // yield Infinity — the zero-qty line imposes no constraint and the real one wins.
    const result = buildableCount([
      { name: 'bad', quantity: 0, stock: 5 },
      { name: 'real', quantity: 2, stock: 6 },
    ]);
    expect(result.count).toBe(3);
    expect(result.limiting.map((c) => c.name)).toEqual(['real']);
  });
});

/** A leaf node: a raw material or on-hand-only item with a fixed stock and no components. */
function leaf(itemId: string, stock: number): KitTreeNode {
  return { itemId, name: itemId, stock, components: [] };
}

/** A kit node composed of `[quantity, sub-node]` component pairs. */
function kit(itemId: string, stock: number, components: [number, KitTreeNode][]): KitTreeNode {
  return {
    itemId,
    name: itemId,
    stock,
    components: components.map(([quantity, node]) => ({ quantity, node })),
  };
}

/**
 * Kits v3 — nested-kit roll-up availability. A sub-kit contributes its *effective* supply
 * (on-hand plus however many more can be built from its own components), and the roll-up nets
 * shared leaves across the acyclic graph so the ceiling matches the draw that realises it —
 * exercised here over deep chains and a diamond, and generalised to gauge (net-value) components.
 */
describe('rollUpBuildable', () => {
  it('rolls a deep chain up to the deepest leaf (A→B→C)', () => {
    // A needs 1 B; B needs 1 C; only C is stocked (10). Building A means building B from C.
    const tree = kit('A', 0, [[1, kit('B', 0, [[1, leaf('C', 10)]])]]);
    const result = rollUpBuildable(tree);
    expect(result.count).toBe(10);
    expect(result.limiting.map((l) => l.itemId)).toEqual(['C']);
    expect(result.subKitCount).toBe(1);
  });

  it('counts on-hand sub-kits *and* those buildable from deeper stock', () => {
    // B has 3 on hand and C stocks 10 more (1 C per B) → 13 effective B → 13 A.
    const tree = kit('A', 0, [[1, kit('B', 3, [[1, leaf('C', 10)]])]]);
    expect(rollUpBuildable(tree).count).toBe(13);
  });

  it('nets a shared leaf across a diamond instead of double-counting it', () => {
    // A needs 1 B + 1 C; B needs 2 D, C needs 3 D — so each A costs 5 D. D stocks 12 → 2 A.
    const d = leaf('D', 12);
    const tree = kit('A', 0, [
      [1, kit('B', 0, [[2, d]])],
      [1, kit('C', 0, [[3, d]])],
    ]);
    const result = rollUpBuildable(tree);
    expect(result.count).toBe(2); // NOT 4 (the optimistic, per-branch figure)
    expect(result.limiting.map((l) => l.itemId)).toEqual(['D']);
    expect(result.subKitCount).toBe(2);
  });

  it('names the deepest limiting leaf through an intermediate sub-kit', () => {
    // A needs 1 B (well stocked leaf) + 1 C (sub-kit gated by scarce E).
    const tree = kit('A', 0, [
      [1, leaf('B', 100)],
      [1, kit('C', 0, [[1, leaf('E', 4)]])],
    ]);
    const result = rollUpBuildable(tree);
    expect(result.count).toBe(4);
    expect(result.limiting.map((l) => l.itemId)).toEqual(['E']);
  });

  it('folds a gauge component in as a net-value ratio', () => {
    // A needs 50 (ml) of gauge G per kit; G holds 220 → floor(220/50) = 4.
    const tree = kit('A', 0, [[50, leaf('G', 220)]]);
    const result = rollUpBuildable(tree);
    expect(result.count).toBe(4);
    expect(result.limiting.map((l) => l.itemId)).toEqual(['G']);
  });

  it('mixes a gauge draw with a discrete component, limited by the scarcer', () => {
    // 50 ml of G (220 → 4 kits) + 1 widget W (3 → 3 kits) → 3, pinned by W.
    const tree = kit('A', 0, [
      [50, leaf('G', 220)],
      [1, leaf('W', 3)],
    ]);
    const result = rollUpBuildable(tree);
    expect(result.count).toBe(3);
    expect(result.limiting.map((l) => l.itemId)).toEqual(['W']);
  });

  it('is 0 for a kit with no components', () => {
    expect(rollUpBuildable(leaf('A', 5))).toEqual({ count: 0, limiting: [], subKitCount: 0 });
  });
});

/**
 * Kits v3 — the assembly plan the repository realises. `planAssembly` explodes a build request
 * into an ordered list of steps: with cascade off it is the single-level v2 build (one step); with
 * it on, every sub-kit short on hand is built first (its step ordered before the parent's) so the
 * whole tree assembles in one pass. An infeasible request reports the leaf shortfalls instead.
 */
describe('planAssembly', () => {
  it('is a single root step when cascade is off (v2 behaviour)', () => {
    const tree = kit('A', 0, [
      [2, leaf('bandage', 10)],
      [1, leaf('scissors', 3)],
    ]);
    const plan = planAssembly(tree, 2, false);
    expect(plan.feasible).toBe(true);
    expect(plan.steps).toHaveLength(1);
    expect(plan.steps[0]).toMatchObject({ itemId: 'A', buildQty: 2 });
    expect(plan.steps[0].draws).toEqual([
      { itemId: 'bandage', quantity: 4 },
      { itemId: 'scissors', quantity: 2 },
    ]);
  });

  it('fails a non-cascade build when a direct sub-kit is short on hand', () => {
    // B is a sub-kit but with cascade off it is drawn from stock only (2 on hand < 3 needed).
    const tree = kit('A', 0, [[1, kit('B', 2, [[1, leaf('C', 100)]])]]);
    const plan = planAssembly(tree, 3, false);
    expect(plan.feasible).toBe(false);
    expect(plan.shortfalls).toEqual([{ itemId: 'B', name: 'B', needed: 3, available: 2 }]);
  });

  it('builds sub-kits first, then the root, in one cascade plan', () => {
    // A→B→C: build 5 A needs 5 B, each B needs 1 C (10 stocked).
    const tree = kit('A', 0, [[1, kit('B', 0, [[1, leaf('C', 10)]])]]);
    const plan = planAssembly(tree, 5, true);
    expect(plan.feasible).toBe(true);
    // Children first: B before A.
    expect(plan.steps.map((s) => s.itemId)).toEqual(['B', 'A']);
    expect(plan.steps.find((s) => s.itemId === 'B')).toMatchObject({ buildQty: 5 });
    expect(plan.steps.find((s) => s.itemId === 'A')).toMatchObject({ buildQty: 5 });
  });

  it('only builds the shortfall of an on-hand sub-kit', () => {
    // B has 2 on hand; building 5 A needs 5 B → build only the 3 missing.
    const tree = kit('A', 0, [[1, kit('B', 2, [[1, leaf('C', 10)]])]]);
    const plan = planAssembly(tree, 5, true);
    expect(plan.steps.find((s) => s.itemId === 'B')).toMatchObject({ buildQty: 3 });
    // The root still consumes all 5 B (2 on hand + 3 freshly built).
    expect(plan.steps.find((s) => s.itemId === 'A')!.draws).toEqual([{ itemId: 'B', quantity: 5 }]);
  });

  it('nets a diamond so a shared leaf is not over-drawn', () => {
    const d = leaf('D', 12);
    const tree = kit('A', 0, [
      [1, kit('B', 0, [[2, d]])],
      [1, kit('C', 0, [[3, d]])],
    ]);
    const plan = planAssembly(tree, 2, true);
    expect(plan.feasible).toBe(true);
    // B and C each built twice; total D drawn = 2×(2+3) = 10 ≤ 12.
    const draws = plan.steps.flatMap((s) => s.draws).filter((d) => d.itemId === 'D');
    expect(draws.reduce((sum, x) => sum + x.quantity, 0)).toBe(10);
    // Requesting a third exceeds D and is refused.
    expect(planAssembly(tree, 3, true).feasible).toBe(false);
  });
});
