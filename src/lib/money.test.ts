import { describe, expect, it } from 'vitest';
import {
  MONEY_DECIMALS,
  MONEY_EPSILON,
  MONEY_STORAGE_DECIMALS,
  MONEY_STORAGE_SCALE,
  fromStoredMoney,
  moneyDecimals,
  moneyExceeds,
  moneyReaches,
  roundMoney,
  sumMoney,
  toStoredMoney,
} from './money';

describe('moneyDecimals', () => {
  it('reports each currency’s real minor unit, not a flat 2 (issue #292)', () => {
    expect(moneyDecimals('GBP')).toBe(2);
    expect(moneyDecimals('USD')).toBe(2);
    expect(moneyDecimals('EUR')).toBe(2);
    expect(moneyDecimals('JPY')).toBe(0); // the yen has no subunit in circulation
    expect(moneyDecimals('BHD')).toBe(3); // 1000 fils to the dinar
  });

  it('normalises case and surrounding whitespace', () => {
    expect(moneyDecimals(' jpy ')).toBe(0);
  });

  it('falls back to the default for an absent or malformed code rather than throwing', () => {
    expect(moneyDecimals(null)).toBe(MONEY_DECIMALS);
    expect(moneyDecimals(undefined)).toBe(MONEY_DECIMALS);
    expect(moneyDecimals('')).toBe(MONEY_DECIMALS);
    expect(moneyDecimals('not-a-code')).toBe(MONEY_DECIMALS);
    // Well-formed but unassigned: `Intl` accepts it and reports the generic 2.
    expect(moneyDecimals('XBT')).toBe(MONEY_DECIMALS);
  });

  it('drives roundMoney to the scale the currency can actually hold', () => {
    // The issue's worked example: 3 × ¥100.5 is 301.5, which is not a payable amount.
    expect(roundMoney(301.5, moneyDecimals('JPY'))).toBe(302);
    expect(roundMoney(301.5, moneyDecimals('GBP'))).toBe(301.5);
    expect(roundMoney(1.2345, moneyDecimals('BHD'))).toBe(1.235);
    expect(roundMoney(1.2345, moneyDecimals('GBP'))).toBe(1.23);
  });
});

describe('roundMoney', () => {
  it('rounds the ties that the old scaled Math.round got wrong', () => {
    // These are the exact cases issue #288 measured: `Math.round(n * 100) / 100` gave 1, 8.16
    // and 2.68 respectively — a lost penny, then a down, then an up, from the same "half" input.
    expect(roundMoney(1.005)).toBe(1.01);
    expect(roundMoney(8.165)).toBe(8.17);
    expect(roundMoney(2.675)).toBe(2.68);
  });

  it('breaks ties away from zero, symmetrically', () => {
    expect(roundMoney(0.005)).toBe(0.01);
    expect(roundMoney(-0.005)).toBe(-0.01);
    expect(roundMoney(1.005)).toBe(1.01);
    expect(roundMoney(-1.005)).toBe(-1.01);
    expect(roundMoney(2.5, 0)).toBe(3);
    expect(roundMoney(-2.5, 0)).toBe(-3);
  });

  it('leaves already-quantised amounts alone', () => {
    for (const value of [0, 1, 12.34, -12.34, 999_999.99]) {
      expect(roundMoney(value)).toBe(value);
    }
  });

  it('strips binary-float noise from a product', () => {
    expect(roundMoney(0.1 * 3)).toBe(0.3);
    expect(roundMoney(1.1 * 1.1)).toBe(1.21);
    expect(roundMoney(0.07 * 100)).toBe(7);
  });

  it('normalises a negative zero so a zeroed total never renders as "-0.00"', () => {
    expect(Object.is(roundMoney(-0.001), 0)).toBe(true);
    expect(Object.is(roundMoney(-0), 0)).toBe(true);
  });

  it('honours a non-default scale', () => {
    expect(roundMoney(1.23456789, 6)).toBe(1.234568);
    expect(roundMoney(1.5, 0)).toBe(2);
    expect(MONEY_DECIMALS).toBe(2);
  });

  it('passes non-finite values straight through rather than inventing a number', () => {
    expect(roundMoney(Number.NaN)).toBeNaN();
    expect(roundMoney(Number.POSITIVE_INFINITY)).toBe(Number.POSITIVE_INFINITY);
    expect(roundMoney(Number.NEGATIVE_INFINITY)).toBe(Number.NEGATIVE_INFINITY);
  });
});

describe('sumMoney', () => {
  it('rounds the total once instead of summing pre-rounded lines', () => {
    // The split-total case from #288: three sales of 3 units at £0.10.
    const lines = [0.1 * 3, 0.1 * 3, 0.1 * 3];
    expect(lines.reduce((a, b) => a + b, 0)).not.toBe(0.9);
    expect(sumMoney(lines)).toBe(0.9);
  });

  it('sums at full precision, so many small amounts do not drift', () => {
    expect(sumMoney(Array.from({ length: 10 }, () => 0.1))).toBe(1);
    expect(sumMoney([0.7, 0.1, 0.2])).toBe(1);
  });

  it('is zero for an empty set', () => {
    expect(sumMoney([])).toBe(0);
  });

  it('handles negatives (refunds, over-spends) without sign bias', () => {
    expect(sumMoney([10.005, -10.005])).toBe(0);
    expect(sumMoney([-1.115, -2.225])).toBe(-3.34);
  });

  it('skips a non-finite addend rather than poisoning the whole total', () => {
    expect(sumMoney([1.5, Number.NaN, 2.25])).toBe(3.75);
    expect(sumMoney([1.5, Number.POSITIVE_INFINITY])).toBe(1.5);
  });

  it('honours a non-default scale', () => {
    expect(sumMoney([0.0000005, 0.0000005], 6)).toBe(0.000001);
  });
});

describe('moneyExceeds / moneyReaches', () => {
  it('ignores the drift a float sum of decimal amounts accumulates (issue #287)', () => {
    // Exactly £200.00 in decimal, but 200.00000000000003 as a double.
    expect(56.2 + 71.9 + 71.9 > 200).toBe(true);
    expect(moneyExceeds(56.2 + 71.9 + 71.9, 200)).toBe(false);
    expect(moneyExceeds(14.3 + 17.85 + 17.85, 50)).toBe(false);
    expect(moneyExceeds(2.1 + 0.45 + 0.45, 3)).toBe(false);
  });

  it('treats a figure short of the limit by drift alone as having reached it', () => {
    // 60% of 8.05 is 4.83, but computes to 4.830000000000001 — which £4.83 does not
    // reach on a bare `>=`, so a spend exactly on the threshold misses its own band.
    const threshold = (8.05 * 60) / 100;
    expect(4.83 >= threshold).toBe(false);
    expect(moneyReaches(4.83, threshold)).toBe(true);
  });

  it('still sees a difference that is real money', () => {
    expect(moneyExceeds(200.01, 200)).toBe(true);
    expect(moneyExceeds(200, 200)).toBe(false);
    expect(moneyReaches(199.99, 200)).toBe(false);
    expect(moneyReaches(200, 200)).toBe(true);
  });

  it('keeps the tolerance far below the minor unit, so no penny is swallowed', () => {
    expect(MONEY_EPSILON).toBeLessThan(10 ** -MONEY_DECIMALS / 1000);
    expect(moneyExceeds(200.001, 200)).toBe(true);
  });

  it('widens the tolerance with magnitude, but never as far as a penny', () => {
    // One step of a double near 1e7 is ~1.9e-9, so a fixed nanopenny would not cover it.
    expect(moneyExceeds(10_000_000 + 1e-8, 10_000_000)).toBe(false);
    expect(moneyExceeds(10_000_000.01, 10_000_000)).toBe(true);
  });

  it('handles negatives and zero symmetrically', () => {
    expect(moneyExceeds(0.1 + 0.2 - 0.3, 0)).toBe(false); // 5.55e-17 is not money
    expect(moneyExceeds(-5, 0)).toBe(false);
    expect(moneyReaches(-5, -5)).toBe(true);
  });
});

describe('toStoredMoney / fromStoredMoney (micro-unit storage, issue #286)', () => {
  it('scales a major-unit amount to integer micro-units and back exactly', () => {
    expect(MONEY_STORAGE_DECIMALS).toBe(6);
    expect(MONEY_STORAGE_SCALE).toBe(1_000_000);
    for (const value of [0, 1, 12.34, 1499.99, 0.07, 0.1, 1.005, 999_999.99]) {
      const stored = toStoredMoney(value);
      expect(Number.isInteger(stored)).toBe(true);
      expect(fromStoredMoney(stored)).toBeCloseTo(value, 6);
    }
  });

  it('stores exact integer micro-units for the amounts a REAL column could not hold', () => {
    expect(toStoredMoney(0.07)).toBe(70_000);
    expect(toStoredMoney(12.5)).toBe(12_500_000);
    expect(toStoredMoney(1499.99)).toBe(1_499_990_000);
    // Six-place sub-penny precision (BOM part costs) survives the round-trip.
    expect(toStoredMoney(0.000001)).toBe(1);
    expect(fromStoredMoney(1)).toBe(0.000001);
  });

  it('makes a summed column exact where REAL drifted (the issue’s worked example)', () => {
    // 5,000 rows at £0.07 summed as REAL gave 349.9999999999724; as integer micro-units it is 350.
    const rows = Array.from({ length: 5000 }, () => toStoredMoney(0.07));
    const totalMicros = rows.reduce((sum, n) => sum + n, 0);
    expect(totalMicros).toBe(350_000_000);
    expect(fromStoredMoney(totalMicros)).toBe(350);
  });

  it('two accumulation orders agree exactly (===), unlike a REAL sum', () => {
    const micros = [1.1, 2.2, 0.3, 1.7, 0.5, -0.5].map((n) => toStoredMoney(n));
    const forward = micros.reduce((sum, n) => sum + n, 0);
    const reversed = [...micros].reverse().reduce((sum, n) => sum + n, 0);
    expect(forward).toBe(reversed); // integer addition is order-independent
    expect(fromStoredMoney(forward)).toBe(5.3);
  });

  it('rounds to the nearest micro-unit, away from zero on a tie', () => {
    // Below the micro-unit floor: rounds rather than storing a fractional integer.
    expect(toStoredMoney(0.0000004)).toBe(0);
    expect(toStoredMoney(0.0000005)).toBe(1);
    expect(toStoredMoney(-0.0000005)).toBe(-1);
  });

  it('maps null / undefined / non-finite to null rather than a spurious zero', () => {
    expect(toStoredMoney(null)).toBeNull();
    expect(toStoredMoney(undefined)).toBeNull();
    expect(toStoredMoney(Number.NaN)).toBeNull();
    expect(toStoredMoney(Number.POSITIVE_INFINITY)).toBeNull();
    expect(fromStoredMoney(null)).toBeNull();
    expect(fromStoredMoney(undefined)).toBeNull();
    expect(fromStoredMoney(Number.NaN)).toBeNull();
  });
});
