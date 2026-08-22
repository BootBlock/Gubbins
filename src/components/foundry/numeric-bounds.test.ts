import { describe, expect, it } from 'vitest';
import {
  applyBounds,
  hasBounds,
  parseNumericText,
  removedBefore,
  resolveBounds,
  sanitiseNumericText,
  stepFrom,
} from './numeric-bounds';

describe('resolveBounds', () => {
  it('reads the numeric attributes a call site declares', () => {
    expect(resolveBounds(0, 100, 1)).toEqual({ min: 0, max: 100, step: 1 });
  });

  it('accepts the string form the DOM hands back', () => {
    expect(resolveBounds('0', '10', '0.5')).toEqual({ min: 0, max: 10, step: 0.5 });
  });

  it('treats step="any" as no step, the way HTML does', () => {
    expect(resolveBounds(0, undefined, 'any')).toEqual({ min: 0, max: undefined, step: undefined });
  });

  it('drops a zero or negative step, which constrains nothing', () => {
    expect(resolveBounds(undefined, undefined, 0).step).toBeUndefined();
    expect(resolveBounds(undefined, undefined, -1).step).toBeUndefined();
  });

  it('drops a maximum that sits below the minimum, which describes no value at all', () => {
    // `min={1} max={available}` with nothing available; honouring the ceiling would report every
    // entry as out of range and emit an aria-valuemax beneath its own aria-valuemin.
    expect(resolveBounds(1, 0, undefined)).toEqual({ min: 1, max: undefined, step: undefined });
  });

  it('reports no bounds when a field declares none', () => {
    expect(hasBounds(resolveBounds(undefined, undefined, undefined))).toBe(false);
    expect(hasBounds(resolveBounds(0, undefined, undefined))).toBe(true);
  });
});

describe('applyBounds', () => {
  it('leaves an in-range, on-grid value alone', () => {
    expect(applyBounds(5, { min: 0, max: 10, step: 1 })).toEqual({ value: 5, adjusted: false });
  });

  it('clamps below the minimum up to it', () => {
    expect(applyBounds(-3, { min: 0 })).toEqual({ value: 0, adjusted: true });
  });

  it('clamps above the maximum down to it', () => {
    expect(applyBounds(250, { max: 100 })).toEqual({ value: 100, adjusted: true });
  });

  it('snaps a fractional entry onto a whole-number step', () => {
    expect(applyBounds(2.5, { min: 0, step: 1 })).toEqual({ value: 3, adjusted: true });
    expect(applyBounds(2.4, { min: 0, step: 1 })).toEqual({ value: 2, adjusted: true });
  });

  it('measures the step from the minimum, not from zero', () => {
    // `min={1} step={2}` describes 1, 3, 5 — so 2 belongs on 1 or 3, never on 2.
    expect(applyBounds(2, { min: 1, step: 2 }).value).toBe(3);
    expect(applyBounds(4, { min: 1, step: 2 }).value).toBe(5);
  });

  it('keeps the declared endpoint reachable even when it sits off the grid', () => {
    expect(applyBounds(99, { min: 0, max: 10, step: 3 })).toEqual({ value: 10, adjusted: true });
  });

  it('does not leave floating-point noise behind', () => {
    expect(applyBounds(0.30000000000000004, { min: 0, step: 0.1 }).value).toBe(0.3);
  });

  it('never trims real precision off a large whole number it had no reason to touch', () => {
    // Rounding to a fixed count of significant digits to clear float noise would rewrite this
    // on-grid figure to 1234567890120 and announce it as a correction it never needed.
    expect(applyBounds(1234567890123, { min: 0, step: 1 })).toEqual({
      value: 1234567890123,
      adjusted: false,
    });
  });

  it('applies nothing when nothing is declared', () => {
    expect(applyBounds(1234.5678, {})).toEqual({ value: 1234.5678, adjusted: false });
  });
});

describe('stepFrom', () => {
  it('moves by the declared step', () => {
    expect(stepFrom(5, { step: 1 }, 1)).toBe(6);
    expect(stepFrom(5, { step: 1 }, -1)).toBe(4);
  });

  it('assumes a step of one where none is declared', () => {
    expect(stepFrom(5, { min: 0 }, 1)).toBe(6);
  });

  it('moves an off-grid value to the next grid point, not a whole step past it', () => {
    expect(stepFrom(2.4, { min: 0, step: 1 }, 1)).toBe(3);
    expect(stepFrom(2.4, { min: 0, step: 1 }, -1)).toBe(2);
  });

  it('stops at the declared range rather than running past it', () => {
    expect(stepFrom(0, { min: 0, max: 10, step: 1 }, -1)).toBe(0);
    expect(stepFrom(10, { min: 0, max: 10, step: 1 }, 1)).toBe(10);
  });

  it('starts from the bottom of the range when the field is blank', () => {
    expect(stepFrom(null, { min: 1, max: 10, step: 1 }, 1)).toBe(1);
    expect(stepFrom(null, {}, -1)).toBe(0);
  });

  it('handles a fractional step without floating-point drift', () => {
    expect(stepFrom(0.2, { min: 0, step: 0.1 }, 1)).toBe(0.3);
  });
});

describe('sanitiseNumericText', () => {
  it('keeps digits, a decimal point and the calculator operators', () => {
    expect(sanitiseNumericText('(2+3)*4 / 2 ^ 2 - 50%')).toBe('(2+3)*4 / 2 ^ 2 - 50%');
    expect(sanitiseNumericText('12.5')).toBe('12.5');
  });

  it('drops letters, so a typed word can never become NaN downstream', () => {
    expect(sanitiseNumericText('abc')).toBe('');
    expect(sanitiseNumericText('12kg')).toBe('12');
  });

  it("keeps an exponent marker, which is part of a number and of the calculator's own output", () => {
    // Dropping the `e` would turn the calculator's own `1e-7` into `1-7`, which the next commit
    // reads as a subtraction and settles to `-6`.
    expect(sanitiseNumericText('1e-7')).toBe('1e-7');
    expect(sanitiseNumericText('4.23911582752e+28')).toBe('4.23911582752e+28');
    expect(parseNumericText('1e-7')).toBe(1e-7);
  });

  it('drops a pasted newline', () => {
    expect(sanitiseNumericText('12\n34')).toBe('1234');
  });

  it('leaves a comma in place rather than guessing which separator it is', () => {
    // `1,000` is a thousand to one reader and `250,00` is two hundred and fifty to another, so
    // removing the character would silently pick one. Kept, it parses as nothing and is reported.
    expect(sanitiseNumericText('1,000')).toBe('1,000');
    expect(parseNumericText('1,000')).toBeNull();
  });

  it('reports how far a caret has to move to stay put', () => {
    expect(removedBefore('12kg', 4)).toBe(2);
    expect(removedBefore('12kg', 2)).toBe(0);
  });
});

describe('parseNumericText', () => {
  it('reads a plain number', () => {
    expect(parseNumericText('12.5')).toBe(12.5);
    expect(parseNumericText(' -3 ')).toBe(-3);
  });

  it('reads a value typed with a thousands space', () => {
    expect(parseNumericText('1 000')).toBe(1000);
  });

  it('reports null for a blank field rather than zero', () => {
    expect(parseNumericText('')).toBeNull();
    expect(parseNumericText('   ')).toBeNull();
  });

  it('reports null for text that is not a number, and for an overflow', () => {
    expect(parseNumericText('abc')).toBeNull();
    expect(parseNumericText('1.2.3')).toBeNull();
    expect(parseNumericText('1e400')).toBeNull();
  });
});
