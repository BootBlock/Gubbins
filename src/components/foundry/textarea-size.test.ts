import { beforeEach, describe, expect, it } from 'vitest';
import { TEXTAREA_SIZES_KEY } from '@/lib/storage-keys';
import { forgetHeight, readRememberedHeight, readRememberedHeights, rememberHeight } from './textarea-size';

describe('remembered textarea heights', () => {
  beforeEach(() => {
    localStorage.removeItem(TEXTAREA_SIZES_KEY);
  });

  it('reports nothing for a box that has never been resized', () => {
    expect(readRememberedHeight('item.notes')).toBeNull();
  });

  it('round-trips a height, keeping boxes independent', () => {
    rememberHeight('item.notes', 220);
    rememberHeight('item.description', 140);

    expect(readRememberedHeight('item.notes')).toBe(220);
    expect(readRememberedHeight('item.description')).toBe(140);
  });

  it('rounds a fractional height', () => {
    rememberHeight('item.notes', 220.4);
    expect(readRememberedHeight('item.notes')).toBe(220);
  });

  it('clamps a stored height that could collapse or balloon the box', () => {
    rememberHeight('tiny', 1);
    rememberHeight('huge', 999_999);

    expect(readRememberedHeight('tiny')).toBe(24);
    expect(readRememberedHeight('huge')).toBe(4000);
  });

  it('ignores a height that is not a finite number', () => {
    rememberHeight('item.notes', Number.NaN);
    rememberHeight('item.description', Number.POSITIVE_INFINITY);

    expect(readRememberedHeights()).toEqual({});
  });

  it('forgets one box without disturbing the others', () => {
    rememberHeight('item.notes', 220);
    rememberHeight('item.description', 140);

    forgetHeight('item.notes');

    expect(readRememberedHeight('item.notes')).toBeNull();
    expect(readRememberedHeight('item.description')).toBe(140);
  });

  it('drops the storage key entirely once the last box is forgotten', () => {
    rememberHeight('item.notes', 220);
    forgetHeight('item.notes');

    expect(localStorage.getItem(TEXTAREA_SIZES_KEY)).toBeNull();
  });

  it('forgetting an unknown box leaves storage untouched', () => {
    rememberHeight('item.notes', 220);
    const before = localStorage.getItem(TEXTAREA_SIZES_KEY);

    forgetHeight('never.resized');

    expect(localStorage.getItem(TEXTAREA_SIZES_KEY)).toBe(before);
  });

  it.each([
    ['malformed JSON', 'not json at all'],
    ['an array', '[220]'],
    ['a scalar', '"220"'],
  ])('falls back to no remembered sizes for %s', (_label, raw) => {
    localStorage.setItem(TEXTAREA_SIZES_KEY, raw);

    expect(readRememberedHeights()).toEqual({});
    expect(readRememberedHeight('item.notes')).toBeNull();
  });

  it('keeps the usable entries of a partly-corrupt map', () => {
    localStorage.setItem(TEXTAREA_SIZES_KEY, JSON.stringify({ good: 220, bad: 'tall', worse: null }));

    expect(readRememberedHeight('good')).toBe(220);
    expect(readRememberedHeight('bad')).toBeNull();
    expect(readRememberedHeight('worse')).toBeNull();
  });

  it('clamps a hand-edited stored value on the way out', () => {
    localStorage.setItem(TEXTAREA_SIZES_KEY, JSON.stringify({ 'item.notes': -50 }));

    expect(readRememberedHeight('item.notes')).toBe(24);
  });
});
