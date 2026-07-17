import { describe, it, expect } from 'vitest';
import { createElement } from 'react';
import {
  reactNodeTextLength,
  toastDurationForLength,
  TOAST_MIN_DURATION_MS,
  TOAST_MAX_DURATION_MS,
  TOAST_MS_PER_CHAR,
} from './toast-duration';

describe('reactNodeTextLength', () => {
  it('counts a plain string', () => {
    expect(reactNodeTextLength('Saved')).toBe(5);
  });

  it('ignores null / boolean / undefined leaves', () => {
    expect(reactNodeTextLength(null)).toBe(0);
    expect(reactNodeTextLength(false)).toBe(0);
    expect(reactNodeTextLength(undefined)).toBe(0);
  });

  it('counts numbers by their string form', () => {
    expect(reactNodeTextLength(1234)).toBe(4);
  });

  it('sums an array of nodes', () => {
    expect(reactNodeTextLength(['ab', 'cde'])).toBe(5);
  });

  it('descends into element children and skips non-text nodes', () => {
    const node = createElement(
      'span',
      null,
      'Deleted ',
      createElement('strong', null, 'Resistors'),
      ' from the catalogue',
    );
    expect(reactNodeTextLength(node)).toBe('Deleted Resistors from the catalogue'.length);
  });
});

describe('toastDurationForLength', () => {
  it('floors short toasts at the minimum dwell', () => {
    expect(toastDurationForLength(0)).toBe(TOAST_MIN_DURATION_MS);
    expect(toastDurationForLength(5)).toBe(TOAST_MIN_DURATION_MS + 5 * TOAST_MS_PER_CHAR);
  });

  it('scales with character count', () => {
    expect(toastDurationForLength(100)).toBe(TOAST_MIN_DURATION_MS + 100 * TOAST_MS_PER_CHAR);
  });

  it('caps very long toasts at the maximum', () => {
    expect(toastDurationForLength(10_000)).toBe(TOAST_MAX_DURATION_MS);
  });

  it('treats a negative count as zero', () => {
    expect(toastDurationForLength(-50)).toBe(TOAST_MIN_DURATION_MS);
  });
});
