import { describe, expect, it } from 'vitest';
import type { AssemblyOutcome } from '@/db/repositories';
import { assemblyShortfallMessage, isEmptyDraw, planAssemblyDraw, type AssemblyPart } from './assembly';

/** A DISCRETE part with the given requirement and on-hand, unless overridden. */
function part(overrides: Partial<AssemblyPart> = {}): AssemblyPart {
  return {
    itemId: 'i1',
    name: 'Screw',
    requiredQty: 4,
    onHand: 500,
    trackingMode: 'DISCRETE',
    isUnlimited: false,
    ...overrides,
  };
}

/** Plan a draw, defaulting to a consuming outcome — the case the issue is about. */
function planDraw(parts: readonly AssemblyPart[], outcome: AssemblyOutcome = 'PERMANENT_CONSUMPTION') {
  return planAssemblyDraw(parts, outcome);
}

describe('planAssemblyDraw (issue #647)', () => {
  it('takes only what the bill of materials asks for, leaving the rest on the shelf', () => {
    const [draw] = planDraw([part()]).draws;
    expect(draw.mode).toBe('COUNT');
    expect(draw.takeQty).toBe(4);
    // The whole point of the issue: 4 screws out of a box of 500 does not retire the box.
    expect(draw.takesAll).toBe(false);
    expect(draw.shortfallQty).toBe(0);
  });

  it('marks a draw that takes the last of the stock', () => {
    const [draw] = planDraw([part({ requiredQty: 500 })]).draws;
    expect(draw.takeQty).toBe(500);
    expect(draw.takesAll).toBe(true);
  });

  it('reports a shortfall rather than taking what little there is', () => {
    const plan = planDraw([part({ requiredQty: 10, onHand: 3 })]);
    expect(plan.feasible).toBe(false);
    expect(plan.shortfalls.map((s) => s.shortfallQty)).toEqual([7]);
    // Nothing on hand at all is the same rejection, not a silent success.
    expect(planDraw([part({ requiredQty: 1, onHand: 0 })]).feasible).toBe(false);
  });

  it('meets a requirement exactly at the on-hand boundary', () => {
    const plan = planDraw([part({ requiredQty: 500, onHand: 500 })]);
    expect(plan.feasible).toBe(true);
    expect(plan.shortfalls).toEqual([]);
  });

  it('takes a serialised instance whole — its quantity is pinned at 1, not drawable by count', () => {
    // Drawing a SERIALISED row by count would take its quantity to 0 and trip the ledger's
    // `CHECK (tracking_mode <> 'SERIALISED' OR quantity = 1)`, aborting the whole finalise.
    const [draw] = planDraw([part({ trackingMode: 'SERIALISED', requiredQty: 1, onHand: 1 })]).draws;
    expect(draw.mode).toBe('WHOLE');
    expect(draw.takeQty).toBe(0);
    expect(draw.takesAll).toBe(true);
    expect(draw.shortfallQty).toBe(0);
  });

  it('draws a gauge part by net value when the build consumes it', () => {
    const [draw] = planDraw(
      [part({ trackingMode: 'CONSUMABLE_GAUGE', requiredQty: 50, onHand: 500 })],
      'PERMANENT_CONSUMPTION',
    ).draws;
    expect(draw.mode).toBe('GAUGE');
    expect(draw.takeQty).toBe(50);
    expect(draw.takesAll).toBe(false);
  });

  it('carries a gauge vessel whole into a container, and never calls it short there', () => {
    // A container gathers the bottle; there is no slice of glue to put in a box. Planning a
    // net-value draw the container outcome then ignores would block the move on a phantom
    // shortfall — the preview promising one thing while the write does another.
    const gauge = part({ trackingMode: 'CONSUMABLE_GAUGE', requiredQty: 600, onHand: 100 });
    const plan = planDraw([gauge], 'CONTAINER');
    expect(plan.draws[0].mode).toBe('WHOLE');
    expect(plan.feasible).toBe(true);
    // The same line under a consuming outcome is genuinely short.
    expect(planDraw([gauge], 'PERMANENT_CONSUMPTION').feasible).toBe(false);
  });

  it('takes a presence-only part whole — there is no quantity to slice', () => {
    const [draw] = planDraw([part({ trackingMode: 'UNTRACKED', requiredQty: 1, onHand: 0 })]).draws;
    expect(draw.mode).toBe('WHOLE');
    expect(draw.takeQty).toBe(0);
    expect(draw.takesAll).toBe(true);
    // Presence-only stock is 0 by definition, so it must never read as a shortfall.
    expect(draw.shortfallQty).toBe(0);
  });

  it('never depletes or shortfalls an infinite source', () => {
    const plan = planDraw([part({ isUnlimited: true, requiredQty: 1000, onHand: 0 })]);
    const [draw] = plan.draws;
    expect(draw.mode).toBe('UNLIMITED');
    expect(draw.takeQty).toBe(1000);
    expect(draw.takesAll).toBe(false);
    expect(plan.feasible).toBe(true);
  });

  it('treats a zero requirement as a no-op, not as taking everything', () => {
    const [draw] = planDraw([part({ requiredQty: 0 })]).draws;
    expect(draw.takeQty).toBe(0);
    expect(draw.takesAll).toBe(false);
    expect(isEmptyDraw(draw)).toBe(true);
    // Even with nothing on hand: a zero draw empties nothing, so it retires nothing.
    const [empty] = planDraw([part({ requiredQty: 0, onHand: 0 })]).draws;
    expect(empty.takesAll).toBe(false);
    expect(isEmptyDraw(empty)).toBe(true);
  });

  it('does not treat a whole-item part as an empty draw — the item itself is what is taken', () => {
    const [draw] = planDraw([part({ trackingMode: 'UNTRACKED' })]).draws;
    expect(isEmptyDraw(draw)).toBe(false);
  });

  it('keeps every part in the plan, shortfalls included, in the order supplied', () => {
    const plan = planDraw([
      part({ itemId: 'a', name: 'A' }),
      part({ itemId: 'b', name: 'B', requiredQty: 9, onHand: 1 }),
      part({ itemId: 'c', name: 'C' }),
    ]);
    expect(plan.draws.map((d) => d.itemId)).toEqual(['a', 'b', 'c']);
    expect(plan.shortfalls.map((d) => d.itemId)).toEqual(['b']);
  });

  it('names every short part and its figures in the rejection message', () => {
    const plan = planDraw([
      part({ itemId: 'a', name: 'M3 screw', requiredQty: 10, onHand: 3 }),
      part({ itemId: 'b', name: 'Washer', requiredQty: 2, onHand: 0 }),
    ]);
    const message = assemblyShortfallMessage('Lamp', plan.shortfalls);
    expect(message).toContain('"Lamp"');
    expect(message).toContain('M3 screw (needs 10, 3 on hand)');
    expect(message).toContain('Washer (needs 2, 0 on hand)');
  });
});
