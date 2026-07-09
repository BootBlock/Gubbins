import { describe, it, expect } from 'vitest';
import { splitLocationPath, isLocationPath } from './location-path';

describe('splitLocationPath', () => {
  it('returns a single segment for a plain name', () => {
    expect(splitLocationPath('Workshop')).toEqual(['Workshop']);
  });

  it('splits on forward slashes into ordered levels', () => {
    expect(splitLocationPath('Workshop/Cabinet A/Drawer 3')).toEqual(['Workshop', 'Cabinet A', 'Drawer 3']);
  });

  it('accepts backslashes as separators too', () => {
    expect(splitLocationPath('Workshop\\Cabinet A\\Drawer 3')).toEqual(['Workshop', 'Cabinet A', 'Drawer 3']);
  });

  it('trims each segment and drops empty ones from stray/doubled separators', () => {
    expect(splitLocationPath(' Workshop // Cabinet A / ')).toEqual(['Workshop', 'Cabinet A']);
  });

  it('yields an empty list for blank or separator-only input', () => {
    expect(splitLocationPath('')).toEqual([]);
    expect(splitLocationPath('  ')).toEqual([]);
    expect(splitLocationPath(' / \\ ')).toEqual([]);
  });
});

describe('isLocationPath', () => {
  it('is true only when more than one level is described', () => {
    expect(isLocationPath('Workshop')).toBe(false);
    expect(isLocationPath('Workshop/')).toBe(false);
    expect(isLocationPath('Workshop/Cabinet A')).toBe(true);
  });
});
