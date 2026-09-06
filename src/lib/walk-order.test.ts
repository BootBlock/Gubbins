import { describe, it, expect } from 'vitest';
import { normaliseWalkOrder, resolveWalkOrderInput } from './walk-order';

describe('normaliseWalkOrder', () => {
  it('keeps a whole non-negative ordinal', () => {
    expect(normaliseWalkOrder(0)).toBe(0);
    expect(normaliseWalkOrder(9)).toBe(9);
  });

  it('floors a fractional ordinal — a rung on a sequence, not a measurement', () => {
    expect(normaliseWalkOrder(2.9)).toBe(2);
  });

  it('folds negative zero to zero, the way the INTEGER column reads it back', () => {
    expect(normaliseWalkOrder(-0)).toBe(0);
    expect(Object.is(normaliseWalkOrder(-0), -0)).toBe(false);
  });

  it('drops the location off the route for anything that cannot be an ordinal', () => {
    expect(normaliseWalkOrder(null)).toBeNull();
    expect(normaliseWalkOrder(undefined)).toBeNull();
    expect(normaliseWalkOrder(-1)).toBeNull();
    expect(normaliseWalkOrder(Number.NaN)).toBeNull();
    expect(normaliseWalkOrder(Number.POSITIVE_INFINITY)).toBeNull();
  });
});

describe('resolveWalkOrderInput', () => {
  it('treats a blank field as "not on the picking route"', () => {
    expect(resolveWalkOrderInput('')).toEqual({ value: null, valid: true });
    expect(resolveWalkOrderInput('   ')).toEqual({ value: null, valid: true });
  });

  it('reads a typed ordinal, flooring it the way the repository stores it', () => {
    expect(resolveWalkOrderInput('0')).toEqual({ value: 0, valid: true });
    expect(resolveWalkOrderInput(' 4 ')).toEqual({ value: 4, valid: true });
    expect(resolveWalkOrderInput('2.9')).toEqual({ value: 2, valid: true });
  });

  it('reports the ordinal the write path settled on, not the spelling that was typed', () => {
    const { value, valid } = resolveWalkOrderInput('-0');
    expect(valid).toBe(true);
    expect(Object.is(value, 0)).toBe(true);
  });

  it('rejects a value the repository would discard rather than store', () => {
    expect(resolveWalkOrderInput('-1').valid).toBe(false);
    expect(resolveWalkOrderInput('-0.5').valid).toBe(false);
    expect(resolveWalkOrderInput('abc').valid).toBe(false);
  });
});
