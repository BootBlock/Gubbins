import { describe, it, expect } from 'vitest';
import {
  currentGrossWeight,
  percentageRemaining,
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
});
