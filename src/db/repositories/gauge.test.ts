import { describe, it, expect } from 'vitest';
import {
  clampNetValue,
  currentGrossWeight,
  percentageRemaining,
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
    expect(weighInNote(650, -45, 'g')).toBe(
      'Calibrated gross weight to 650g (Calculated usage: -45g)',
    );
    expect(weighInNote(900, 250, 'g')).toBe(
      'Calibrated gross weight to 900g (Calculated usage: +250g)',
    );
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
