import { describe, it, expect } from 'vitest';
import type { NavGroup } from '@/components/nav/nav-destinations';
import {
  defaultOrder,
  mergeGated,
  moveTile,
  normaliseOrder,
  nudgeTile,
  reconcileOrder,
  setTilePinned,
  tilesInGroup,
  type NavOrder,
  type NavTileDefault,
} from './dashboard-nav-order';

const GROUPS: readonly NavGroup[] = ['primary', 'manage', 'system'];

const DEFAULTS: readonly NavTileDefault[] = [
  { id: 'a', group: 'primary' },
  { id: 'b', group: 'primary' },
  { id: 'c', group: 'primary' },
  { id: 'd', group: 'manage' },
  { id: 'e', group: 'manage' },
  { id: 'f', group: 'system' },
];

/** Compact "id[group,pin]" view of an order for readable assertions. */
const ids = (order: NavOrder): string[] => order.map((p) => p.id);
const groupIds = (order: NavOrder, group: NavGroup): string[] => tilesInGroup(order, group).map((p) => p.id);

describe('dashboard-nav-order — defaults & reconcile', () => {
  it('defaultOrder places every tile in its shipped group, unpinned, in SSOT order', () => {
    const order = defaultOrder(DEFAULTS, GROUPS);
    expect(ids(order)).toEqual(['a', 'b', 'c', 'd', 'e', 'f']);
    expect(order.every((p) => !p.pinned)).toBe(true);
  });

  it('reconcile of an empty stored order yields the default order', () => {
    expect(reconcileOrder([], DEFAULTS, GROUPS)).toEqual(defaultOrder(DEFAULTS, GROUPS));
  });

  it('reconcile keeps a stored arrangement (group + pin + relative order) for known ids', () => {
    const stored: NavOrder = [
      { id: 'c', group: 'primary', pinned: true },
      { id: 'a', group: 'manage', pinned: false },
      { id: 'b', group: 'primary', pinned: false },
      { id: 'd', group: 'manage', pinned: false },
      { id: 'e', group: 'manage', pinned: false },
      { id: 'f', group: 'system', pinned: false },
    ];
    const order = reconcileOrder(stored, DEFAULTS, GROUPS);
    // 'c' is pinned to the top of primary; 'a' was moved into manage.
    expect(groupIds(order, 'primary')).toEqual(['c', 'b']);
    expect(groupIds(order, 'manage')).toEqual(['a', 'd', 'e']);
    expect(order.find((p) => p.id === 'c')?.pinned).toBe(true);
  });

  it('reconcile drops unknown ids and appends newly-added tiles into their default group', () => {
    const stored: NavOrder = [
      { id: 'zzz', group: 'primary', pinned: true }, // no longer exists → dropped
      { id: 'a', group: 'primary', pinned: false },
      { id: 'b', group: 'primary', pinned: false },
      { id: 'd', group: 'manage', pinned: false },
      // 'c', 'e', 'f' are "new" (absent from stored) → appended to their default groups
    ];
    const order = reconcileOrder(stored, DEFAULTS, GROUPS);
    expect(ids(order)).not.toContain('zzz');
    expect(groupIds(order, 'primary')).toEqual(['a', 'b', 'c']); // c appended at end
    expect(groupIds(order, 'manage')).toEqual(['d', 'e']); // e appended after d
    expect(groupIds(order, 'system')).toEqual(['f']);
  });

  it('reconcile falls back to the default group for a stored tile with a stale group', () => {
    const stored: NavOrder = [{ id: 'a', group: 'nonsense' as NavGroup, pinned: false }];
    const order = reconcileOrder(stored, DEFAULTS, GROUPS);
    // 'a' reverts to its default group (primary) rather than vanishing.
    expect(groupIds(order, 'primary')).toContain('a');
    expect(ids(order).sort()).toEqual(['a', 'b', 'c', 'd', 'e', 'f']);
  });
});

describe('dashboard-nav-order — normalise (pinned float to top)', () => {
  it('stably partitions each group pinned-first while preserving relative order', () => {
    const loose: NavOrder = [
      { id: 'a', group: 'primary', pinned: false },
      { id: 'b', group: 'primary', pinned: true },
      { id: 'c', group: 'primary', pinned: true },
      { id: 'd', group: 'manage', pinned: false },
    ];
    expect(groupIds(normaliseOrder(loose, GROUPS), 'primary')).toEqual(['b', 'c', 'a']);
  });

  it('appends a tile in an unrecognised group rather than dropping it', () => {
    const loose: NavOrder = [{ id: 'x', group: 'ghost' as NavGroup, pinned: false }];
    expect(ids(normaliseOrder(loose, GROUPS))).toEqual(['x']);
  });
});

describe('dashboard-nav-order — moveTile', () => {
  const base = defaultOrder(DEFAULTS, GROUPS);

  it('reorders within a group', () => {
    const order = moveTile(base, 'c', 'primary', 0, GROUPS);
    expect(groupIds(order, 'primary')).toEqual(['c', 'a', 'b']);
  });

  it('moves a tile into a different group at the given index', () => {
    const order = moveTile(base, 'a', 'manage', 1, GROUPS);
    expect(groupIds(order, 'primary')).toEqual(['b', 'c']);
    expect(groupIds(order, 'manage')).toEqual(['d', 'a', 'e']);
    expect(order.find((p) => p.id === 'a')?.group).toBe('manage');
  });

  it('returns the same reference on a no-op move', () => {
    expect(moveTile(base, 'a', 'primary', 0, GROUPS)).toBe(base);
  });

  it('returns the same reference for an unknown id', () => {
    expect(moveTile(base, 'nope', 'primary', 0, GROUPS)).toBe(base);
  });

  it('lands an unpinned tile at the top of the unpinned run when dropped among the pins', () => {
    const pinned = setTilePinned(base, 'a', true, GROUPS); // primary: [a*, b, c]
    const order = moveTile(pinned, 'c', 'primary', 0, GROUPS); // drop c above the pin
    // c cannot jump above the pin — it lands at the head of the unpinned run.
    expect(groupIds(order, 'primary')).toEqual(['a', 'c', 'b']);
  });
});

describe('dashboard-nav-order — nudgeTile', () => {
  const base = defaultOrder(DEFAULTS, GROUPS);

  it('moves a tile up and down within its group', () => {
    expect(groupIds(nudgeTile(base, 'b', 'up', GROUPS), 'primary')).toEqual(['b', 'a', 'c']);
    expect(groupIds(nudgeTile(base, 'b', 'down', GROUPS), 'primary')).toEqual(['a', 'c', 'b']);
  });

  it('clamps at the top / bottom of a group (no-op, same reference)', () => {
    expect(nudgeTile(base, 'a', 'up', GROUPS)).toBe(base);
    expect(nudgeTile(base, 'c', 'down', GROUPS)).toBe(base);
  });

  it('will not cross the pinned/unpinned boundary with up/down', () => {
    const pinned = setTilePinned(base, 'a', true, GROUPS); // primary: [a*, b, c]
    // 'b' (unpinned, first of its run) can't move up into the pinned run.
    expect(nudgeTile(pinned, 'b', 'up', GROUPS)).toBe(pinned);
  });

  it('moves a tile to the adjacent group with left/right', () => {
    const right = nudgeTile(base, 'a', 'right', GROUPS); // primary → manage
    expect(right.find((p) => p.id === 'a')?.group).toBe('manage');
    expect(groupIds(right, 'manage')).toEqual(['d', 'e', 'a']); // appended to the end

    const left = nudgeTile(base, 'd', 'left', GROUPS); // manage → primary
    expect(left.find((p) => p.id === 'd')?.group).toBe('primary');
  });

  it('clamps left/right at the first / last group', () => {
    expect(nudgeTile(base, 'a', 'left', GROUPS)).toBe(base); // primary is leftmost
    expect(nudgeTile(base, 'f', 'right', GROUPS)).toBe(base); // system is rightmost
  });
});

describe('dashboard-nav-order — setTilePinned', () => {
  const base = defaultOrder(DEFAULTS, GROUPS);

  it('floats a pinned tile to the top of its group', () => {
    expect(groupIds(setTilePinned(base, 'c', true, GROUPS), 'primary')).toEqual(['c', 'a', 'b']);
  });

  it('drops an unpinned tile below the remaining pins', () => {
    const twoPins = setTilePinned(setTilePinned(base, 'a', true, GROUPS), 'b', true, GROUPS); // [a*, b*, c]
    const order = setTilePinned(twoPins, 'a', false, GROUPS); // unpin a
    // b stays pinned at top; a drops to the head of the unpinned run.
    expect(groupIds(order, 'primary')).toEqual(['b', 'a', 'c']);
  });

  it('returns the same reference when the flag already matches', () => {
    expect(setTilePinned(base, 'a', false, GROUPS)).toBe(base);
  });
});

describe('dashboard-nav-order — mergeGated', () => {
  /** The pipeline a nav edit really goes through: hide some tiles, edit the visible ones, merge
   *  back. Fails if any of the three steps loses a hidden tile's position. */
  const edit = (order: NavOrder, hidden: readonly string[], op: (enabled: NavOrder) => NavOrder): NavOrder =>
    mergeGated(order, op(order.filter((p) => !hidden.includes(p.id))), GROUPS);

  /** Five tiles in one group — enough room for a move that is nowhere near the hidden tile. */
  const WIDE: readonly NavTileDefault[] = ['p1', 'p2', 'p3', 'p4', 'p5'].map((id) => ({
    id,
    group: 'primary' as NavGroup,
  }));

  it('keeps a hidden tile in place when an unrelated tile moves (issue #628)', () => {
    const base = defaultOrder(WIDE, GROUPS);
    const next = edit(base, ['p2'], (enabled) => nudgeTile(enabled, 'p5', 'up', GROUPS));
    expect(groupIds(next, 'primary')).toEqual(['p1', 'p2', 'p3', 'p5', 'p4']);
  });

  it('keeps a hidden tile behind the neighbour it sat behind when that neighbour moves', () => {
    const base = defaultOrder(DEFAULTS, GROUPS);
    const next = edit(base, ['b'], (enabled) => nudgeTile(enabled, 'c', 'up', GROUPS));
    expect(groupIds(next, 'primary')).toEqual(['c', 'a', 'b']);
  });

  it('puts a hidden head-of-group tile back at the head', () => {
    const base = defaultOrder(DEFAULTS, GROUPS);
    const next = edit(base, ['a'], (enabled) => nudgeTile(enabled, 'c', 'up', GROUPS));
    expect(groupIds(next, 'primary')).toEqual(['a', 'c', 'b']);
  });

  it('survives repeated edits without drifting the hidden tile', () => {
    const base = defaultOrder(DEFAULTS, GROUPS);
    let order = base;
    for (let i = 0; i < 4; i++) {
      order = edit(order, ['b'], (enabled) => nudgeTile(enabled, 'c', 'up', GROUPS));
      order = edit(order, ['b'], (enabled) => nudgeTile(enabled, 'c', 'down', GROUPS));
    }
    expect(groupIds(order, 'primary')).toEqual(['a', 'b', 'c']);
  });

  it('keeps a hidden tile in its group when the tile it sat behind leaves the group', () => {
    // 'b' sits behind 'a'; moving 'a' to manage leaves 'b' at the head of primary, not at
    // the end of it.
    const base = defaultOrder(DEFAULTS, GROUPS);
    const next = edit(base, ['b'], (enabled) => moveTile(enabled, 'a', 'manage', 0, GROUPS));
    expect(groupIds(next, 'primary')).toEqual(['b', 'c']);
    expect(groupIds(next, 'manage')).toEqual(['a', 'd', 'e']);
  });

  it('keeps a hidden pinned tile in the pinned run', () => {
    const base = setTilePinned(defaultOrder(DEFAULTS, GROUPS), 'b', true, GROUPS);
    expect(groupIds(base, 'primary')).toEqual(['b', 'a', 'c']);
    const next = edit(base, ['b'], (enabled) => nudgeTile(enabled, 'c', 'up', GROUPS));
    expect(groupIds(next, 'primary')).toEqual(['b', 'c', 'a']);
    expect(next.find((p) => p.id === 'b')?.pinned).toBe(true);
  });

  it('leaves an order with nothing hidden exactly as the edit produced it', () => {
    const base = defaultOrder(DEFAULTS, GROUPS);
    const next = nudgeTile(base, 'c', 'up', GROUPS);
    expect(mergeGated(base, next, GROUPS)).toEqual(next);
  });
});
