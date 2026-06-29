import { describe, it, expect } from 'vitest';
import { nextTrapIndex, FOCUSABLE_SELECTOR } from './focus-trap';

describe('nextTrapIndex', () => {
  it('steps forward within the set', () => {
    expect(nextTrapIndex(4, 0, false)).toBe(1);
    expect(nextTrapIndex(4, 2, false)).toBe(3);
  });

  it('wraps forward off the last element to the first', () => {
    expect(nextTrapIndex(4, 3, false)).toBe(0);
  });

  it('steps backward within the set', () => {
    expect(nextTrapIndex(4, 3, true)).toBe(2);
    expect(nextTrapIndex(4, 1, true)).toBe(0);
  });

  it('wraps backward off the first element to the last', () => {
    expect(nextTrapIndex(4, 0, true)).toBe(3);
  });

  it('enters at the first element when focus is outside the set (Tab)', () => {
    expect(nextTrapIndex(4, -1, false)).toBe(0);
  });

  it('enters at the last element when focus is outside the set (Shift+Tab)', () => {
    expect(nextTrapIndex(4, -1, true)).toBe(3);
  });

  it('returns null when there is nothing focusable', () => {
    expect(nextTrapIndex(0, -1, false)).toBeNull();
    expect(nextTrapIndex(0, 0, true)).toBeNull();
  });

  it('keeps focus on the sole element when only one is focusable', () => {
    expect(nextTrapIndex(1, 0, false)).toBe(0);
    expect(nextTrapIndex(1, 0, true)).toBe(0);
    expect(nextTrapIndex(1, -1, false)).toBe(0);
  });

  it('excludes negative-tabindex and disabled controls from the selector', () => {
    expect(FOCUSABLE_SELECTOR).toContain('button:not([disabled])');
    expect(FOCUSABLE_SELECTOR).toContain('[tabindex]:not([tabindex="-1"])');
  });
});
