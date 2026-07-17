import { describe, expect, it } from 'vitest';
import { evaluateExpression, formatCalcResult, hasCalcExpression } from './evaluate-expression';

/** Convenience: assert an expression evaluates to a specific finite value. */
function evalsTo(input: string, expected: number) {
  const result = evaluateExpression(input);
  expect(result.ok, `"${input}" should evaluate`).toBe(true);
  if (result.ok) expect(result.value).toBeCloseTo(expected, 10);
}

/** Convenience: assert an expression is rejected cleanly. */
function rejects(input: string) {
  expect(evaluateExpression(input).ok, `"${input}" should be rejected`).toBe(false);
}

describe('evaluateExpression', () => {
  it('evaluates the four basic operations', () => {
    evalsTo('500/2', 250);
    evalsTo('2+3', 5);
    evalsTo('10-4', 6);
    evalsTo('6*7', 42);
  });

  it('honours operator precedence and parentheses', () => {
    evalsTo('2+3*4', 14);
    evalsTo('(2+3)*4', 20);
    evalsTo('2*(3+4)-1', 13);
    evalsTo('((1+2)*(3+4))', 21);
  });

  it('supports decimals, including leading/trailing dots', () => {
    evalsTo('1.5+2.5', 4);
    evalsTo('.5*10', 5);
    evalsTo('5.*2', 10);
    evalsTo('0.1+0.2', 0.3);
  });

  it('supports unary sign and negative results', () => {
    evalsTo('-5', -5);
    evalsTo('3+-2', 1);
    evalsTo('-(2+3)', -5);
    evalsTo('--5', 5);
  });

  it('treats a postfix % as divide-by-100', () => {
    evalsTo('50%', 0.5);
    evalsTo('200*50%', 100);
    evalsTo('10%+5%', 0.15);
  });

  it('supports right-associative power', () => {
    evalsTo('2^10', 1024);
    evalsTo('2^3^2', 512); // 2^(3^2), not (2^3)^2 = 64
  });

  it('accepts the Unicode × ÷ − operator glyphs', () => {
    evalsTo('6×7', 42);
    evalsTo('500÷2', 250);
    evalsTo('10−4', 6); // U+2212 minus sign
  });

  it('ignores surrounding and interior whitespace', () => {
    evalsTo('  500 / 2  ', 250);
    evalsTo('2 + 3 * 4', 14);
  });

  it('rejects malformed input without throwing', () => {
    rejects('');
    rejects('   ');
    rejects('500/');
    rejects('*5');
    rejects('(2+3');
    rejects('2+3)');
    rejects('2..3');
    rejects('.');
    rejects('abc');
    rejects('5 5');
    rejects('2 3');
  });

  it('rejects non-finite results (division by zero, overflow)', () => {
    rejects('5/0');
    rejects('0/0');
    rejects('1e308*10'); // 'e' is not a token, so this is malformed anyway
    rejects('9^9^9'); // overflows to Infinity
  });
});

describe('hasCalcExpression', () => {
  it('is false for blank or plainly-typed numbers', () => {
    expect(hasCalcExpression('')).toBe(false);
    expect(hasCalcExpression('   ')).toBe(false);
    expect(hasCalcExpression('42')).toBe(false);
    expect(hasCalcExpression('-12.5')).toBe(false);
    expect(hasCalcExpression('+3')).toBe(false);
    expect(hasCalcExpression('.5')).toBe(false);
  });

  it('is true when an operator or parenthesis is present', () => {
    expect(hasCalcExpression('500/2')).toBe(true);
    expect(hasCalcExpression('2+3')).toBe(true);
    expect(hasCalcExpression('(2)')).toBe(true);
    expect(hasCalcExpression('50%')).toBe(true);
    expect(hasCalcExpression('6×7')).toBe(true);
  });

  it('is false for free text with no operator (so it is not previewed as a failed sum)', () => {
    expect(hasCalcExpression('abc')).toBe(false);
    expect(hasCalcExpression('12kg')).toBe(false);
  });
});

describe('formatCalcResult', () => {
  it('renders clean, parseable numeric strings', () => {
    expect(formatCalcResult(250)).toBe('250');
    expect(formatCalcResult(12.5)).toBe('12.5');
    expect(formatCalcResult(12.0)).toBe('12');
  });

  it('trims binary floating-point noise', () => {
    expect(formatCalcResult(0.1 + 0.2)).toBe('0.3');
    expect(formatCalcResult(1 / 3)).toBe('0.333333333333');
  });

  it('round-trips through Number()', () => {
    for (const v of [250, 12.5, -7, 0.3, 1000000]) {
      expect(Number(formatCalcResult(v))).toBeCloseTo(v, 10);
    }
  });
});
