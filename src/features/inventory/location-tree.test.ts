import { describe, it, expect } from 'vitest';
import {
  collectDescendantIds,
  defaultLocationForNewItem,
  defaultParentForNewLocation,
  flattenVisibleTree,
  locationPath,
  locationsMatchingQuery,
  matchingWithAncestors,
  pruneArchivedTree,
  pruneTreeToIds,
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

describe('matchingWithAncestors + pruneTreeToIds (tag filter, issue #84)', () => {
  it('keeps a match and every ancestor up to the root', () => {
    // drawer matches → keep drawer, cabinet, workshop; bench/garage excluded.
    const keep = matchingWithAncestors(new Set(['drawer']), nodes);
    expect(keep).toEqual(new Set(['drawer', 'cabinet', 'workshop']));
  });

  it('unions the ancestor paths of several matches', () => {
    const keep = matchingWithAncestors(new Set(['bench', 'garage']), nodes);
    expect(keep).toEqual(new Set(['bench', 'workshop', 'garage']));
  });

  it('prunes a nested tree to only the kept ids', () => {
    const tree = [
      {
        id: 'workshop',
        children: [
          { id: 'cabinet', children: [{ id: 'drawer', children: [] }] },
          { id: 'bench', children: [] },
        ],
      },
      { id: 'garage', children: [] },
    ];
    const keep = matchingWithAncestors(new Set(['drawer']), nodes);
    const pruned = pruneTreeToIds(tree, keep);
    expect(pruned.map((n) => n.id)).toEqual(['workshop']);
    expect(pruned[0]!.children.map((n) => n.id)).toEqual(['cabinet']);
    expect(pruned[0]!.children[0]!.children.map((n) => n.id)).toEqual(['drawer']);
  });
});

describe('flattenVisibleTree', () => {
  interface TestNode {
    id: string;
    children: TestNode[];
  }
  const branch = (id: string, children: TestNode[] = []): TestNode => ({ id, children });
  // a → a1 → a1a; a → a2; plus b.
  const tree: TestNode[] = [branch('a', [branch('a1', [branch('a1a')]), branch('a2')]), branch('b')];

  it('omits the descendants of a collapsed node', () => {
    const rows = flattenVisibleTree(tree, (id) => id === 'a');
    expect(rows.map((r) => r.node.id)).toEqual(['a', 'a1', 'a2', 'b']);
  });

  it('walks the whole tree in render order when everything is open', () => {
    const rows = flattenVisibleTree(tree, () => true);
    expect(rows.map((r) => r.node.id)).toEqual(['a', 'a1', 'a1a', 'a2', 'b']);
  });

  it('reports each row depth and its position among its own siblings', () => {
    const rows = flattenVisibleTree(tree, () => true);
    expect(rows.map((r) => [r.node.id, r.level, r.posInSet, r.setSize])).toEqual([
      ['a', 1, 1, 2],
      ['a1', 2, 1, 2],
      ['a1a', 3, 1, 1],
      ['a2', 2, 2, 2],
      ['b', 1, 2, 2],
    ]);
  });

  it('asks about expansion only for nodes that have children, passing their level', () => {
    const seen: [string, number][] = [];
    flattenVisibleTree(tree, (id, level) => {
      seen.push([id, level]);
      return true;
    });
    // `a1a`, `a2` and `b` are leaves — there is nothing to expand, so they are never asked.
    expect(seen).toEqual([
      ['a', 1],
      ['a1', 2],
    ]);
  });
});

describe('locationsMatchingQuery', () => {
  it('matches nothing for an empty or whitespace-only query', () => {
    expect(locationsMatchingQuery(nodes, '')).toEqual(new Set());
    expect(locationsMatchingQuery(nodes, '   ')).toEqual(new Set());
  });

  it('matches a location by its own name, case-insensitively', () => {
    expect(locationsMatchingQuery(nodes, 'GARAGE')).toEqual(new Set(['garage']));
  });

  it('matches on the ancestry path, so an ancestor name narrows to its subtree', () => {
    // "Workshop" itself plus everything beneath it — Garage is not under it.
    expect(locationsMatchingQuery(nodes, 'workshop')).toEqual(
      new Set(['workshop', 'cabinet', 'drawer', 'bench']),
    );
  });

  it('AND-s whitespace-separated terms across the whole path', () => {
    // Only Drawer 3 has both "cabinet" (an ancestor) and "3" (its own name) on its path.
    expect(locationsMatchingQuery(nodes, 'cabinet 3')).toEqual(new Set(['drawer']));
  });

  it('matches nothing when a term appears nowhere', () => {
    expect(locationsMatchingQuery(nodes, 'workshop attic')).toEqual(new Set());
  });

  it('terminates on a cyclic parent chain', () => {
    const cyclic: FlatNode[] = [
      { id: 'x', name: 'Xylophone', parentId: 'y' },
      { id: 'y', name: 'Yacht', parentId: 'x' },
    ];
    expect(locationsMatchingQuery(cyclic, 'yacht')).toEqual(new Set(['x', 'y']));
  });
});
