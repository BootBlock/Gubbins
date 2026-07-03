import { describe, it, expect } from 'vitest';
import {
  UNLIMITED_GLYPH,
  isUnlimited,
  canSupply,
  consumptionLedgerDelta,
  formatQuantityDisplay,
} from './unlimited';

const unlimited = { isUnlimited: true, quantity: 0 };
const finite = { isUnlimited: false, quantity: 5 };

describe('unlimited-supply seam', () => {
  it('isUnlimited narrows on the flag only', () => {
    expect(isUnlimited({ isUnlimited: true })).toBe(true);
    expect(isUnlimited({ isUnlimited: false })).toBe(false);
  });

  describe('canSupply', () => {
    it('is always true for an unlimited item, regardless of quantity', () => {
      expect(canSupply(unlimited, 1)).toBe(true);
      expect(canSupply(unlimited, 1_000_000)).toBe(true);
      expect(canSupply({ isUnlimited: true, quantity: 0 }, 42)).toBe(true);
    });

    it('honours finite on-hand stock for a normal item', () => {
      expect(canSupply(finite, 5)).toBe(true); // exactly enough
      expect(canSupply(finite, 4)).toBe(true);
      expect(canSupply(finite, 6)).toBe(false); // short
    });
  });

  describe('consumptionLedgerDelta', () => {
    it('is 0 for an unlimited item (never decrements infinity)', () => {
      expect(consumptionLedgerDelta(unlimited, 3)).toBe(0);
      expect(consumptionLedgerDelta(unlimited, 0)).toBe(0);
    });

    it('is -qty for a finite item (the usual decrement)', () => {
      expect(consumptionLedgerDelta(finite, 3)).toBe(-3);
      expect(consumptionLedgerDelta(finite, 0)).toBe(-0);
    });
  });

  describe('formatQuantityDisplay', () => {
    const fmt = { quantity: (n: number) => `${n} pcs` };

    it('renders the ∞ glyph for an unlimited item, ignoring the stored quantity', () => {
      expect(formatQuantityDisplay({ isUnlimited: true, quantity: 999 }, fmt)).toBe(UNLIMITED_GLYPH);
      expect(UNLIMITED_GLYPH).toBe('∞');
    });

    it('formats the real quantity for a finite item', () => {
      expect(formatQuantityDisplay(finite, fmt)).toBe('5 pcs');
    });
  });
});
