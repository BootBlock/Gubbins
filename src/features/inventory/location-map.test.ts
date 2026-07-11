import { describe, expect, it } from 'vitest';
import type { LocationTreeNode } from '@/db/repositories';
import {
  buildLocationMap,
  childrenAtRoot,
  indexLocationTree,
  locationMapTiles,
  rootAncestry,
  subtreeItemCount,
} from './location-map';

/** Minimal tree-node factory — only the fields the map maths reads. */
function node(
  id: string,
  itemCount: number,
  children: LocationTreeNode[] = [],
  extra: Partial<LocationTreeNode> = {},
): LocationTreeNode {
  return {
    id,
    name: id.toUpperCase(),
    parentId: null,
    isSystem: false,
    description: null,
    color: null,
    kind: null,
    capacity: null,
    isDefault: false,
    archivedAt: null,
    lastCountedAt: null,
    updatedAt: 0,
    itemCount,
    children,
    ...extra,
  };
}

// garage(2) → { bench(3), cabinet(0) → { drawer(5) } }; shed(4)
const tree: LocationTreeNode[] = [
  node('garage', 2, [
    node('bench', 3, [], { parentId: 'garage' }),
    node('cabinet', 0, [node('drawer', 5, [], { parentId: 'cabinet' })], { parentId: 'garage' }),
  ]),
  node('shed', 4),
];

describe('subtreeItemCount', () => {
  it('sums a location and all its descendants', () => {
    const garage = tree[0]!;
    expect(subtreeItemCount(garage)).toBe(2 + 3 + 0 + 5); // 10
    expect(subtreeItemCount(garage.children[1]!)).toBe(5); // cabinet + drawer
    expect(subtreeItemCount(tree[1]!)).toBe(4); // shed (leaf)
  });
});

describe('childrenAtRoot / indexLocationTree', () => {
  const index = indexLocationTree(tree);
  it('returns the top level for a null root', () => {
    expect(childrenAtRoot(tree, null, index).map((n) => n.id)).toEqual(['garage', 'shed']);
  });
  it('returns the direct children of a real root', () => {
    expect(childrenAtRoot(tree, 'garage', index).map((n) => n.id)).toEqual(['bench', 'cabinet']);
  });
  it('returns nothing for an unknown or leaf root', () => {
    expect(childrenAtRoot(tree, 'nope', index)).toEqual([]);
    expect(childrenAtRoot(tree, 'shed', index)).toEqual([]);
  });
});

describe('rootAncestry', () => {
  const index = indexLocationTree(tree);
  it('is empty at the top level', () => {
    expect(rootAncestry(null, index)).toEqual([]);
  });
  it('walks root-first down to the target', () => {
    expect(rootAncestry('drawer', index).map((n) => n.id)).toEqual(['garage', 'cabinet', 'drawer']);
  });
});

describe('locationMapTiles', () => {
  it('sizes tiles by subtree total plus the baseline floor', () => {
    const tiles = locationMapTiles(tree);
    const garage = tiles.find((t) => t.id === 'garage')!;
    expect(garage.subtreeCount).toBe(10);
    expect(garage.directCount).toBe(2);
    expect(garage.childCount).toBe(2);
    expect(garage.weight).toBe(11); // 10 + baseline 1
  });

  it('keeps an empty location visible via the baseline weight', () => {
    const tiles = locationMapTiles([node('empty', 0)]);
    expect(tiles[0]!.subtreeCount).toBe(0);
    expect(tiles[0]!.weight).toBe(1);
  });
});

describe('buildLocationMap', () => {
  it('prunes archived branches out of the level and the counts', () => {
    const withArchived: LocationTreeNode[] = [node('live', 1), node('gone', 9, [], { archivedAt: 123 })];
    const { tiles } = buildLocationMap(withArchived, null);
    expect(tiles.map((t) => t.id)).toEqual(['live']);
  });

  it('returns the level tiles and breadcrumb for a re-rooted location', () => {
    const { tiles, ancestry } = buildLocationMap(tree, 'garage');
    expect(tiles.map((t) => t.id)).toEqual(['bench', 'cabinet']);
    expect(ancestry.map((n) => n.id)).toEqual(['garage']);
  });
});
