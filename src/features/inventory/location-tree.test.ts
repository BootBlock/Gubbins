import { describe, it, expect } from 'vitest';
import {
  collectDescendantIds,
  defaultLocationForNewItem,
  defaultParentForNewLocation,
  findTreeNode,
  flattenVisibleTree,
  withinArchivedBranch,
  locationAncestry,
  locationPath,
  locationsMatchingQuery,
  matchingWithAncestors,
  pruneArchivedTree,
  pruneTreeToIds,
  type FlatNode,
  type FlatSystemNode,
} from './location-tree';
import { buildParentOptions, type ParentLocationRow } from './parent-options';
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

describe('locationAncestry', () => {
  it('runs from the location itself outwards to the root', () => {
    expect(locationAncestry('drawer', nodes)).toEqual(['drawer', 'cabinet', 'workshop']);
  });

  it('is just the location for a top-level one', () => {
    expect(locationAncestry('garage', nodes)).toEqual(['garage']);
  });

  it('is empty for a location that is not in the list', () => {
    expect(locationAncestry('missing', nodes)).toEqual([]);
  });

  it('stops cleanly on a broken parent chain', () => {
    const orphan: FlatNode[] = [{ id: 'x', name: 'X', parentId: 'missing' }];
    expect(locationAncestry('x', orphan)).toEqual(['x']);
  });

  it('terminates on a cyclic parent chain rather than looping forever', () => {
    const cyclic: FlatNode[] = [
      { id: 'a', name: 'A', parentId: 'b' },
      { id: 'b', name: 'B', parentId: 'a' },
    ];
    expect(locationAncestry('a', cyclic)).toEqual(['a', 'b']);
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

/**
 * The same rows as the `flat` fixtures below plus an archived one, in both the shapes the two
 * seams take.
 * "Show archived" is the only way an archived row reaches the sidebar selection at all, so it
 * is the only way the seed and the picker can disagree.
 */
const ARCHIVED_AWARE_FLAT: FlatSystemNode[] = [
  { id: 'workshop', name: 'Workshop', parentId: null, isSystem: false },
  { id: 'cabinet', name: 'Cabinet A', parentId: 'workshop', isSystem: false },
  { id: 'unassigned', name: 'Unassigned', parentId: null, isSystem: true },
  { id: 'transit', name: 'In Transit', parentId: null, isSystem: true },
  { id: 'retired', name: 'Old Shed', parentId: null, isSystem: false, archivedAt: 1_700_000_000_000 },
];

const ARCHIVED_AWARE_ROWS: ParentLocationRow[] = ARCHIVED_AWARE_FLAT.map((n) => ({
  id: n.id,
  name: n.name,
  isSystem: n.isSystem,
  itemCount: 0,
  color: null,
  archivedAt: n.archivedAt ?? null,
}));

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

  it('defaults to top level for an archived selection (reachable via "Show archived")', () => {
    expect(defaultParentForNewLocation('retired', ARCHIVED_AWARE_FLAT)).toBeNull();
  });
});

/**
 * Drift guard (issue #254). `defaultParentForNewLocation`'s docstring claims its exclusions are
 * the dialogs' own parent filter; this is what holds the claim up. A parent the picker does not
 * offer would blank the field on open and still submit, filing the new location under a parent
 * the user cannot see — which is exactly what an archived selection used to do.
 */
describe('defaultParentForNewLocation ↔ buildParentOptions parity (issue #254)', () => {
  const offered = new Set(
    buildParentOptions(ARCHIVED_AWARE_ROWS, (n) => String(n))
      .map((o) => o.value)
      .filter((v) => v !== ''),
  );

  it('only ever seeds a parent the Add-location picker actually offers', () => {
    for (const node of ARCHIVED_AWARE_FLAT) {
      const seeded = defaultParentForNewLocation(node.id, ARCHIVED_AWARE_FLAT);
      if (seeded !== null) expect(offered.has(seeded)).toBe(true);
    }
    // And the null selection, which the picker represents as its leading "top level" row.
    expect(defaultParentForNewLocation(null, ARCHIVED_AWARE_FLAT)).toBeNull();
  });

  it('seeds every parent the picker offers, so a selectable row is never silently ignored', () => {
    for (const id of offered) {
      expect(defaultParentForNewLocation(id, ARCHIVED_AWARE_FLAT)).toBe(id);
    }
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

  it('falls back rather than seeding an archived selection (issue #254)', () => {
    expect(defaultLocationForNewItem('retired', ARCHIVED_AWARE_FLAT)).toBe(UNASSIGNED_LOCATION_ID);
  });
});

describe('findTreeNode (issue #525)', () => {
  interface Node {
    id: string;
    label: string;
    children: Node[];
  }
  const n = (id: string, children: Node[] = []): Node => ({ id, label: id.toUpperCase(), children });
  const tree = [n('a', [n('a1'), n('a2', [n('a2x')])]), n('b')];

  it('finds a node nested at any depth, with everything it carries', () => {
    expect(findTreeNode(tree, 'a2x')).toEqual(n('a2x'));
    // The whole node, not a copy of its id: callers read fields only the tree read computes.
    expect(findTreeNode(tree, 'a2')?.label).toBe('A2');
  });

  it('finds a root node', () => {
    expect(findTreeNode(tree, 'b')?.id).toBe('b');
  });

  it('returns undefined for an id nothing carries, and for an empty tree', () => {
    expect(findTreeNode(tree, 'nope')).toBeUndefined();
    expect(findTreeNode([], 'a')).toBeUndefined();
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

describe('withinArchivedBranch (issue #713)', () => {
  // workshop (archived) → cabinet → drawer; garage → bench. Only the workshop carries a date.
  const archivedNodes: FlatSystemNode[] = [
    { id: 'workshop', name: 'Workshop', parentId: null, isSystem: false, archivedAt: 1_700_000_000 },
    { id: 'cabinet', name: 'Cabinet A', parentId: 'workshop', isSystem: false, archivedAt: null },
    { id: 'drawer', name: 'Drawer 3', parentId: 'cabinet', isSystem: false, archivedAt: null },
    { id: 'garage', name: 'Garage', parentId: null, isSystem: false, archivedAt: null },
    { id: 'bench', name: 'Bench', parentId: 'garage', isSystem: false, archivedAt: null },
    // `pruneArchivedTree` keeps a node whose `archivedAt` is 0 (it tests falsiness, not null), so
    // this side has to as well — the one input on which a `!= null` test would disagree with it.
    { id: 'shed', name: 'Shed', parentId: null, isSystem: false, archivedAt: 0 },
  ];

  it('is true for the archived location itself', () => {
    expect(withinArchivedBranch('workshop', archivedNodes)).toBe(true);
  });

  it('is true for a live location beneath an archived one, at any depth', () => {
    expect(withinArchivedBranch('cabinet', archivedNodes)).toBe(true);
    expect(withinArchivedBranch('drawer', archivedNodes)).toBe(true);
  });

  it('is false outside the archived subtree', () => {
    expect(withinArchivedBranch('garage', archivedNodes)).toBe(false);
    expect(withinArchivedBranch('bench', archivedNodes)).toBe(false);
  });

  it('reads a 0 timestamp as not archived, as the prune does', () => {
    expect(withinArchivedBranch('shed', archivedNodes)).toBe(false);
  });

  it('is false for an id that is not in the list at all', () => {
    // A location created moments ago, before the tree refetch — nothing to hide it yet.
    expect(withinArchivedBranch('not-here', archivedNodes)).toBe(false);
  });

  it('agrees with pruneArchivedTree on every node (the drift test the doc comment names)', () => {
    // Both sides are driven over the same shape and compared by *verdict*: for every location,
    // does the pruned tree still hold a row for it, and does the predicate say it is hidden?
    interface TreeNode {
      id: string;
      archivedAt: number | null;
      children: TreeNode[];
    }
    const byParent = (parentId: string | null): TreeNode[] =>
      archivedNodes
        .filter((n) => n.parentId === parentId)
        .map((n) => ({ id: n.id, archivedAt: n.archivedAt ?? null, children: byParent(n.id) }));
    const pruned = pruneArchivedTree(byParent(null));

    for (const node of archivedNodes) {
      expect({ id: node.id, hidden: withinArchivedBranch(node.id, archivedNodes) }).toEqual({
        id: node.id,
        hidden: findTreeNode(pruned, node.id) === undefined,
      });
    }
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

  // Issue #617 (`N2`): a location's own text — its description and its custom-field values — is
  // searched alongside the ancestry path, so a note a user wrote about a place can be retrieved.
  describe("a location's own text", () => {
    const described: FlatNode[] = [
      { id: 'garage', name: 'Garage', parentId: null, description: 'Damp in winter — no paper here' },
      { id: 'shed', name: 'Shed', parentId: null, description: null },
      { id: 'bin', name: 'Bin 3', parentId: 'shed' },
    ];

    it('matches a word from the description', () => {
      expect(locationsMatchingQuery(described, 'damp')).toEqual(new Set(['garage']));
    });

    it('lets one term come from the name and another from the description', () => {
      expect(locationsMatchingQuery(described, 'garage winter')).toEqual(new Set(['garage']));
    });

    it('never inherits a description down the tree', () => {
      const nested: FlatNode[] = [
        { id: 'shed', name: 'Shed', parentId: null, description: 'Unventilated' },
        { id: 'bin', name: 'Bin 3', parentId: 'shed' },
      ];
      expect(locationsMatchingQuery(nested, 'unventilated')).toEqual(new Set(['shed']));
    });

    it('matches a custom-field value when the field text is supplied', () => {
      const fieldText = new Map([['bin', 'M6 stainless']]);
      expect(locationsMatchingQuery(described, 'stainless', fieldText)).toEqual(new Set(['bin']));
    });

    it('falls back to path + description when the field text has not loaded', () => {
      expect(locationsMatchingQuery(described, 'stainless')).toEqual(new Set());
      expect(locationsMatchingQuery(described, 'damp', undefined)).toEqual(new Set(['garage']));
    });

    it('cannot match a term straddling the join between two pieces of text', () => {
      const fieldText = new Map([['garage', 'dry']]);
      // "hereDry" spans the description/field-value boundary and is text the location doesn't hold.
      expect(locationsMatchingQuery(described, 'heredry', fieldText)).toEqual(new Set());
    });
  });
});
