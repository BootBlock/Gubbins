import { describe, it, expect } from 'vitest';
import {
  attritionDraw,
  attritionNote,
  clampNetValue,
  currentGrossWeight,
  isValidAttritionPercent,
  estimateDelta,
  estimateNetValue,
  estimateNote,
  GAUGE_LEVELS,
  percentageRemaining,
  reconfigureNote,
  resolveGaugeReconfiguration,
  refillDelta,
  refillNote,
  refillToFullAmount,
  weighInNote,
  weighInToDelta,
} from './gauge';

describe('consumable gauge maths (§4.1)', () => {
  it('computes percentage remaining', () => {
    expect(percentageRemaining(400, 1000)).toBe(40);
    expect(percentageRemaining(1000, 1000)).toBe(100);
    expect(percentageRemaining(0, 1000)).toBe(0);
  });

  it('guards against a zero or negative gross capacity', () => {
    expect(percentageRemaining(50, 0)).toBe(0);
    expect(percentageRemaining(50, -1)).toBe(0);
  });

  it('computes current gross weight as net + tare', () => {
    expect(currentGrossWeight(400, 250)).toBe(650);
    expect(currentGrossWeight(0, 250)).toBe(250);
  });

  it('converts an absolute weigh-in into a relative delta', () => {
    // Scale reads 650g, tare 250g → new net 400g. Was 445g → delta -45g.
    expect(weighInToDelta(650, 445, 250)).toBe(-45);
  });

  it('produces a positive delta when material is added back', () => {
    // Refilled: scale reads 900g, tare 250g → new net 650g. Was 400g → +250g.
    expect(weighInToDelta(900, 400, 250)).toBe(250);
  });

  it('formats the canonical weigh-in ledger note (§4.1.3)', () => {
    expect(weighInNote(650, -45, 'g')).toBe('Calibrated gross weight to 650g (Calculated usage: -45g)');
    expect(weighInNote(900, 250, 'g')).toBe('Calibrated gross weight to 900g (Calculated usage: +250g)');
  });

  it('clamps a net value to [0, grossCapacity]', () => {
    expect(clampNetValue(400, 1000)).toBe(400);
    expect(clampNetValue(-50, 1000)).toBe(0);
    expect(clampNetValue(1200, 1000)).toBe(1000); // overfill capped at capacity
    expect(clampNetValue(1200, 0)).toBe(1200); // mis-configured capacity: lower bound only
  });

  it('computes the amount needed to fill back to full', () => {
    expect(refillToFullAmount(400, 1000)).toBe(600);
    expect(refillToFullAmount(1000, 1000)).toBe(0);
    expect(refillToFullAmount(1100, 1000)).toBe(0); // already over: never negative
  });

  it('converts a refill into the clamped applied delta', () => {
    expect(refillDelta(600, 400, 1000)).toBe(600); // tops up exactly to full
    expect(refillDelta(800, 400, 1000)).toBe(600); // adding past full only tops off to capacity
    expect(refillDelta(100, 400, 1000)).toBe(100); // partial top-up
  });

  it('formats the refill ledger note', () => {
    expect(refillNote(600, 1000, 'g')).toBe('Refilled +600g (now 1000g)');
    expect(refillNote(0, 1000, 'g')).toBe('Refilled 0g (now 1000g)');
  });
});

describe('consumable gauge "Estimate" quick-set (issue #95)', () => {
  it('offers full → empty levels mapped to whole-quarter coefficients', () => {
    expect(GAUGE_LEVELS.map((l) => l.percent)).toEqual([100, 75, 50, 25, 0]);
    // Ordered full → empty so the slider reads left (full) to right (empty).
    expect(GAUGE_LEVELS[0]!.key).toBe('full');
    expect(GAUGE_LEVELS.at(-1)!.key).toBe('empty');
  });

  it('maps a fill level to a net value clamped to capacity', () => {
    expect(estimateNetValue(100, 1000)).toBe(1000);
    expect(estimateNetValue(50, 1000)).toBe(500);
    expect(estimateNetValue(25, 1000)).toBe(250);
    expect(estimateNetValue(0, 1000)).toBe(0);
    expect(estimateNetValue(150, 1000)).toBe(1000); // never exceeds a full unit
  });

  it('converts a chosen level into a signed relative delta from the current net', () => {
    // Half a 1000g spool currently at 800g → set to 500g → -300g.
    expect(estimateDelta(50, 800, 1000)).toBe(-300);
    // Nearly-empty 100g reel refilled to full → +900g.
    expect(estimateDelta(100, 100, 1000)).toBe(900);
    // Picking the level it is already at is a no-op.
    expect(estimateDelta(50, 500, 1000)).toBe(0);
  });

  it('formats the estimate ledger note', () => {
    expect(estimateNote('Half', 50, 500, 'g')).toBe('Estimated Half (~50%, now 500g)');
    expect(estimateNote('Empty', 0, 0, 'g')).toBe('Estimated Empty (~0%, now 0g)');
  });
});

describe('gauge reconfiguration (issue #69)', () => {
  const spool = {
    unitOfMeasure: 'g',
    grossCapacity: 1000,
    tareWeight: 250,
    currentNetValue: 800,
    attritionPercent: null,
  };

  it('leaves omitted fields exactly as they were', () => {
    const next = resolveGaugeReconfiguration(spool, { tareWeight: 300 });
    expect(next.unitOfMeasure).toBe('g');
    expect(next.grossCapacity).toBe(1000);
    expect(next.tareWeight).toBe(300);
  });

  it('reports no change when every field matches the current configuration', () => {
    expect(resolveGaugeReconfiguration(spool, {}).changed).toBe(false);
    expect(resolveGaugeReconfiguration(spool, { grossCapacity: 1000, unitOfMeasure: 'g' }).changed).toBe(
      false,
    );
    expect(resolveGaugeReconfiguration(spool, { unitOfMeasure: 'm' }).changed).toBe(true);
  });

  it('re-taring never moves the material in the gauge', () => {
    // The tare is what a *scale* subtracts, not part of the contents — issue #69.
    const next = resolveGaugeReconfiguration(spool, { tareWeight: 400 });
    expect(next.currentNetValue).toBe(800);
    expect(next.netValueDelta).toBe(0);
  });

  it('relabelling the unit never moves the material either', () => {
    const next = resolveGaugeReconfiguration(spool, { unitOfMeasure: 'm' });
    expect(next.currentNetValue).toBe(800);
    expect(next.netValueDelta).toBe(0);
  });

  it('spills the excess when the new capacity is below the current level', () => {
    const next = resolveGaugeReconfiguration(spool, { grossCapacity: 600 });
    expect(next.currentNetValue).toBe(600);
    expect(next.netValueDelta).toBe(-200);
  });

  it('growing the capacity leaves the level untouched', () => {
    const next = resolveGaugeReconfiguration(spool, { grossCapacity: 2000 });
    expect(next.currentNetValue).toBe(800);
    expect(next.netValueDelta).toBe(0);
  });

  it('composes a note naming only the fields that changed', () => {
    const next = resolveGaugeReconfiguration(spool, { unitOfMeasure: 'm' });
    expect(reconfigureNote(spool, next)).toBe('Gauge reconfigured: unit g → m');
  });

  it('spells out the discarded excess in the note', () => {
    const next = resolveGaugeReconfiguration(spool, { grossCapacity: 600 });
    expect(reconfigureNote(spool, next)).toBe(
      'Gauge reconfigured: capacity 1000g → 600g (200g over capacity discarded)',
    );
  });
});

describe('gauge reconfiguration notes label each side with its own unit', () => {
  const spool = {
    unitOfMeasure: 'g',
    grossCapacity: 1000,
    tareWeight: 250,
    currentNetValue: 800,
    attritionPercent: null,
  };

  it('does not restate the old capacity in the new unit', () => {
    // The 1000 was grams; calling it "1000m" would put a falsehood in an append-only ledger.
    const next = resolveGaugeReconfiguration(spool, { unitOfMeasure: 'm', grossCapacity: 600 });
    expect(reconfigureNote(spool, next)).toBe(
      'Gauge reconfigured: unit g → m, capacity 1000g → 600m (200m over capacity discarded)',
    );
  });

  it('labels a re-tare the same way', () => {
    const next = resolveGaugeReconfiguration(spool, { unitOfMeasure: 'kg', tareWeight: 300 });
    expect(reconfigureNote(spool, next)).toBe('Gauge reconfigured: unit g → kg, tare 250g → 300kg');
  });

  it('says so rather than trailing off when nothing changed', () => {
    const next = resolveGaugeReconfiguration(spool, {});
    expect(reconfigureNote(spool, next)).toBe('Gauge reconfigured: no change');
  });
});

describe('attrition (issue #89)', () => {
  const spool = {
    unitOfMeasure: 'g',
    grossCapacity: 1000,
    tareWeight: 250,
    currentNetValue: 800,
    attritionPercent: null,
  };

  it('adds proportional waste on top of the requested amount', () => {
    // The issue's own example: ask for 100 g of flour at 10%, 110 g actually leaves.
    expect(attritionDraw(100, 10)).toEqual({ requested: 100, waste: 10, total: 110 });
  });

  it('scales with the size of the draw rather than adding a flat overhead', () => {
    // A *factor*, not an adder — this is the distinction the design turns on, so pin it.
    expect(attritionDraw(20, 10).waste).toBe(2);
    expect(attritionDraw(200, 10).waste).toBe(20);
  });

  it('is the identity when the item has no attrition rate', () => {
    expect(attritionDraw(100, null)).toEqual({ requested: 100, waste: 0, total: 100 });
    expect(attritionDraw(100, 0)).toEqual({ requested: 100, waste: 0, total: 100 });
  });

  it('ignores an out-of-range or non-finite rate rather than inventing a draw', () => {
    expect(attritionDraw(100, 150).total).toBe(100);
    expect(attritionDraw(100, -5).total).toBe(100);
    expect(attritionDraw(100, Number.NaN).total).toBe(100);
  });

  it('yields a zero draw for a non-positive or non-finite request', () => {
    expect(attritionDraw(0, 10)).toEqual({ requested: 0, waste: 0, total: 0 });
    expect(attritionDraw(-5, 10)).toEqual({ requested: 0, waste: 0, total: 0 });
    expect(attritionDraw(Number.NaN, 10)).toEqual({ requested: 0, waste: 0, total: 0 });
  });

  it('rounds away float noise so the ledger note stays readable', () => {
    // 33 × 15% is 4.949999999999999 in raw IEEE754; an append-only note must not say that.
    expect(attritionDraw(33, 15).waste).toBe(4.95);
    // The sum needs rounding too: 12.3 + 0.861 is 13.161000000000001 unaided.
    expect(attritionDraw(12.3, 7).total).toBe(13.161);
    expect(attritionDraw(99.9, 11).total).toBe(110.889);
  });

  it('keeps total exactly requested + waste', () => {
    for (const [amount, rate] of [
      [100, 10],
      [12.3, 7],
      [0.7, 13],
      [99.9, 11],
      [33, 15],
    ] as const) {
      const d = attritionDraw(amount, rate);
      expect(d.total).toBe(Math.round((d.requested + d.waste) * 1e4) / 1e4);
    }
  });

  it('accepts only rates inside the bounds', () => {
    expect(isValidAttritionPercent(0)).toBe(true);
    expect(isValidAttritionPercent(100)).toBe(true);
    expect(isValidAttritionPercent(10.5)).toBe(true);
    expect(isValidAttritionPercent(-1)).toBe(false);
    expect(isValidAttritionPercent(101)).toBe(false);
    expect(isValidAttritionPercent(Number.POSITIVE_INFINITY)).toBe(false);
  });

  it('names both figures in the ledger note', () => {
    expect(attritionNote(attritionDraw(100, 10), 'g')).toBe('Used 100g (+10g waste, 110g total)');
  });

  it('distinguishes clearing the rate from leaving it alone', () => {
    const rated = { ...spool, attritionPercent: 10 };
    // undefined = leave as-is; null = clear. Collapsing these would strand the feature on.
    expect(resolveGaugeReconfiguration(rated, {}).attritionPercent).toBe(10);
    expect(resolveGaugeReconfiguration(rated, { attritionPercent: null }).attritionPercent).toBeNull();
    expect(resolveGaugeReconfiguration(rated, { attritionPercent: null }).changed).toBe(true);
  });

  it('treats a changed rate as a real reconfiguration and names it in the note', () => {
    const next = resolveGaugeReconfiguration(spool, { attritionPercent: 10 });
    expect(next.changed).toBe(true);
    expect(reconfigureNote(spool, next)).toBe('Gauge reconfigured: attrition none → 10%');
  });

  it('never moves the material in the gauge when only the rate changes', () => {
    const next = resolveGaugeReconfiguration(spool, { attritionPercent: 10 });
    expect(next.currentNetValue).toBe(800);
    expect(next.netValueDelta).toBe(0);
  });
});
