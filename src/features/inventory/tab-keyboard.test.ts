import { describe, it, expect } from 'vitest';
import { resolveTabKey } from './tab-keyboard';

/** The five ItemDetailDialog tab ids, in render order. */
const tabs = ['supplier', 'lifecycle', 'media', 'classification', 'activity'] as const;

describe('resolveTabKey — APG vertical tabs keyboard navigation', () => {
  it('returns null for an empty tablist', () => {
    expect(resolveTabKey([], null, 'ArrowDown')).toBeNull();
  });

  it('ArrowDown / ArrowRight move to the next tab', () => {
    expect(resolveTabKey(tabs, 'lifecycle', 'ArrowDown')).toBe('media');
    expect(resolveTabKey(tabs, 'lifecycle', 'ArrowRight')).toBe('media');
  });

  it('ArrowUp / ArrowLeft move to the previous tab', () => {
    expect(resolveTabKey(tabs, 'media', 'ArrowUp')).toBe('lifecycle');
    expect(resolveTabKey(tabs, 'media', 'ArrowLeft')).toBe('lifecycle');
  });

  it('ArrowDown wraps from the last tab back to the first', () => {
    expect(resolveTabKey(tabs, 'activity', 'ArrowDown')).toBe('supplier');
  });

  it('ArrowUp wraps from the first tab to the last', () => {
    expect(resolveTabKey(tabs, 'supplier', 'ArrowUp')).toBe('activity');
  });

  it('Home / End jump to the first / last tab', () => {
    expect(resolveTabKey(tabs, 'media', 'Home')).toBe('supplier');
    expect(resolveTabKey(tabs, 'media', 'End')).toBe('activity');
  });

  it('enters at the first tab when the focused id is unknown or null', () => {
    expect(resolveTabKey(tabs, null, 'ArrowDown')).toBe('supplier');
    expect(resolveTabKey(tabs, 'gone', 'ArrowUp')).toBe('supplier');
  });

  it('returns null for keys it does not handle', () => {
    expect(resolveTabKey(tabs, 'media', 'Enter')).toBeNull();
    expect(resolveTabKey(tabs, 'media', 'a')).toBeNull();
  });
});
