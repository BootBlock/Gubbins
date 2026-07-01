import { describe, it, expect } from 'vitest';
import {
  collectDescendantIds,
  defaultLocationForNewItem,
  defaultParentForNewLocation,
  locationPath,
  pruneArchivedTree,
  type FlatNode,
  type FlatSystemNode,
} from './location-tree';
import { UNASSIGNED_LOCATION_ID } from '@/db/repositories/constants';

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

describe('defaultParentForNewLocation', () => {
  const flat: FlatSystemNode[] = [
    { id: 'workshop', name: 'Workshop', parentId: null, isSystem: false },
    { id: 'cabinet', name: 'Cabinet A', parentId: 'workshop', isSystem: false },
    { id: 'unassigned', name: 'Unassigned', parentId: null, isSystem: true },
    { id: 'transit', name: 'In Transit', parentId: null, isSystem: true },
  ];

  it('nests under a real, user-created selection', () => {
    expect(defaultParentForNewLocation('cabinet', flat)).toBe('cabinet');
  });

  it('defaults to top level for the "All items" (null) selection', () => {
    expect(defaultParentForNewLocation(null, flat)).toBeNull();
  });

  it('defaults to top level for the system-locked Unassigned / In Transit rows', () => {
    expect(defaultParentForNewLocation('unassigned', flat)).toBeNull();
    expect(defaultParentForNewLocation('transit', flat)).toBeNull();
  });

  it('defaults to top level when the selection is no longer in the list', () => {
    expect(defaultParentForNewLocation('deleted', flat)).toBeNull();
  });
});

describe('defaultLocationForNewItem', () => {
  const flat: FlatSystemNode[] = [
    { id: 'workshop', name: 'Workshop', parentId: null, isSystem: false },
    { id: 'cabinet', name: 'Cabinet A', parentId: 'workshop', isSystem: false },
    { id: 'unassigned', name: 'Unassigned', parentId: null, isSystem: true },
    { id: 'transit', name: 'In Transit', parentId: null, isSystem: true },
  ];

  it('pre-fills a real, user-created selection', () => {
    expect(defaultLocationForNewItem('cabinet', flat)).toBe('cabinet');
  });

  it('falls back to Unassigned for the "All items" (null) selection', () => {
    expect(defaultLocationForNewItem(null, flat)).toBe(UNASSIGNED_LOCATION_ID);
  });

  it('falls back to Unassigned for the system-locked Unassigned / In Transit rows', () => {
    expect(defaultLocationForNewItem('unassigned', flat)).toBe(UNASSIGNED_LOCATION_ID);
    expect(defaultLocationForNewItem('transit', flat)).toBe(UNASSIGNED_LOCATION_ID);
  });

  it('falls back to Unassigned when the selection is no longer in the list', () => {
    expect(defaultLocationForNewItem('deleted', flat)).toBe(UNASSIGNED_LOCATION_ID);
  });

  it('uses the supplied fallback (the marked default) instead of Unassigned when idle', () => {
    expect(defaultLocationForNewItem(null, flat, 'workshop')).toBe('workshop');
    // An explicit, valid selection still wins over the fallback.
    expect(defaultLocationForNewItem('cabinet', flat, 'workshop')).toBe('cabinet');
  });
});

describe('pruneArchivedTree', () => {
  interface Node {
    id: string;
    archivedAt: number | null;
    children: Node[];
  }
  const n = (id: string, archivedAt: number | null, children: Node[] = []): Node => ({
    id,
    archivedAt,
    children,
  });

  it('drops archived nodes and their whole subtree', () => {
    const tree = [
      n('a', null, [n('a1', null), n('a2', 123, [n('a2x', null)])]),
      n('b', 456, [n('b1', null)]),
    ];
    const pruned = pruneArchivedTree(tree);
    expect(pruned.map((x) => x.id)).toEqual(['a']);
    expect(pruned[0]!.children.map((x) => x.id)).toEqual(['a1']);
  });

  it('is a no-op when nothing is archived', () => {
    const tree = [n('a', null, [n('a1', null)])];
    expect(pruneArchivedTree(tree)).toEqual(tree);
  });
});
