import { describe, expect, it } from 'vitest';
import { MONEY_DECIMALS, MONEY_EPSILON, moneyExceeds, moneyReaches, roundMoney, sumMoney } from './money';

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
