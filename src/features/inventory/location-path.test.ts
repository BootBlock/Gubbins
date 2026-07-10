import { describe, it, expect } from 'vitest';
import { splitLocationPath, splitLeafSiblings, parseLocationBranch, isLocationPath } from './location-path';

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

describe('splitLeafSiblings', () => {
  it('returns a single name for a comma-free leaf', () => {
    expect(splitLeafSiblings('Box 1')).toEqual(['Box 1']);
  });

  it('fans a comma-separated leaf out into sibling names', () => {
    expect(splitLeafSiblings('Box 1, Box 2, Box 3')).toEqual(['Box 1', 'Box 2', 'Box 3']);
  });

  it('trims each name and drops empties from stray/doubled separators', () => {
    expect(splitLeafSiblings(' Box 1 , , Box 2, ')).toEqual(['Box 1', 'Box 2']);
  });

  it('treats a doubled comma as an escaped literal comma', () => {
    expect(splitLeafSiblings('Bay 1,, 2')).toEqual(['Bay 1, 2']);
    expect(splitLeafSiblings('Bay 1,, 2, Bay 3')).toEqual(['Bay 1, 2', 'Bay 3']);
  });

  it('yields an empty list for a blank or comma-only leaf', () => {
    expect(splitLeafSiblings('')).toEqual([]);
    expect(splitLeafSiblings('  ')).toEqual([]);
    expect(splitLeafSiblings(', ,')).toEqual([]);
  });
});

describe('parseLocationBranch', () => {
  it('treats a plain name as a single leaf with no ancestors', () => {
    expect(parseLocationBranch('Workshop')).toEqual({ ancestors: [], leaves: ['Workshop'] });
  });

  it('splits a nested path into its ancestor chain and single leaf', () => {
    expect(parseLocationBranch('Workshop/Cabinet A/Drawer 3')).toEqual({
      ancestors: ['Workshop', 'Cabinet A'],
      leaves: ['Drawer 3'],
    });
  });

  it('fans the leaf level out into sibling leaves under the shared ancestors', () => {
    expect(parseLocationBranch('Garage/Box 1, Box 2, Box 3')).toEqual({
      ancestors: ['Garage'],
      leaves: ['Box 1', 'Box 2', 'Box 3'],
    });
  });

  it('only fans out at the leaf — a comma above the leaf stays literal', () => {
    expect(parseLocationBranch('Garage, Shed/Box')).toEqual({
      ancestors: ['Garage, Shed'],
      leaves: ['Box'],
    });
  });

  it('honours the doubled-comma escape in the leaf', () => {
    expect(parseLocationBranch('Garage/Bay 1,, 2')).toEqual({
      ancestors: ['Garage'],
      leaves: ['Bay 1, 2'],
    });
  });

  it('yields no leaves for blank or separator-only input', () => {
    expect(parseLocationBranch('')).toEqual({ ancestors: [], leaves: [] });
    expect(parseLocationBranch(' / \\ ')).toEqual({ ancestors: [], leaves: [] });
  });
});
