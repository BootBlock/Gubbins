import { describe, it, expect } from 'vitest';
import { collectDescendantIds, locationPath, type FlatNode } from './location-tree';

// workshop → cabinet → drawer; workshop → bench; plus a detached garage.
const nodes: FlatNode[] = [
  { id: 'workshop', name: 'Workshop', parentId: null },
  { id: 'cabinet', name: 'Cabinet A', parentId: 'workshop' },
  { id: 'drawer', name: 'Drawer 3', parentId: 'cabinet' },
  { id: 'bench', name: 'Bench', parentId: 'workshop' },
  { id: 'garage', name: 'Garage', parentId: null },
];

describe('collectDescendantIds', () => {
  it('includes the node itself plus every descendant', () => {
    expect(collectDescendantIds('workshop', nodes)).toEqual(
      new Set(['workshop', 'cabinet', 'drawer', 'bench']),
    );
  });

  it('returns just the node for a leaf', () => {
    expect(collectDescendantIds('drawer', nodes)).toEqual(new Set(['drawer']));
  });

  it('is unaffected by unrelated subtrees', () => {
    expect(collectDescendantIds('garage', nodes)).toEqual(new Set(['garage']));
  });
});

describe('locationPath', () => {
  it('builds a root-first breadcrumb', () => {
    expect(locationPath('drawer', nodes)).toBe('Workshop / Cabinet A / Drawer 3');
  });

  it('is just the name for a top-level location', () => {
    expect(locationPath('garage', nodes)).toBe('Garage');
  });

  it('stops cleanly on a broken parent chain', () => {
    const orphan: FlatNode[] = [{ id: 'x', name: 'X', parentId: 'missing' }];
    expect(locationPath('x', orphan)).toBe('X');
  });
});
