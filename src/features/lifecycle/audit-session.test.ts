import { describe, it, expect } from 'vitest';
import {
  startAudit,
  markLocation,
  goToIndex,
  advance,
  resumeAt,
  nextPendingIndex,
  firstPendingIndex,
  progress,
  summarise,
  statusOf,
  normaliseAuditSession,
  recordFor,
  isTerminal,
  collectAuditableInOrder,
  buildScope,
  type AuditScopeLocation,
  type AuditSessionState,
  type AuditTreeNode,
} from './audit-session';

// --- Fixtures -------------------------------------------------------------------

const SCOPE: AuditScopeLocation[] = [
  { id: 'a', name: 'Drawer A' },
  { id: 'b', name: 'Drawer B' },
  { id: 'c', name: 'Drawer C' },
];

/** A three-location fresh session. */
function fresh(): AuditSessionState {
  return startAudit(SCOPE);
}

// --- isTerminal / status helpers ------------------------------------------------

describe('audit-session — status helpers', () => {
  it('treats only pending as non-terminal', () => {
    expect(isTerminal('pending')).toBe(false);
    expect(isTerminal('counted')).toBe(true);
    expect(isTerminal('reconciled')).toBe(true);
    expect(isTerminal('skipped')).toBe(true);
  });

  it('defaults an untouched location to a pending record', () => {
    const state = fresh();
    expect(statusOf(state, 'a')).toBe('pending');
    expect(recordFor(state, 'a')).toEqual({ status: 'pending', variancesFound: 0, adjustmentsMade: 0 });
    // An id not even in scope still yields the pending default (total helper).
    expect(statusOf(state, 'zzz')).toBe('pending');
  });
});

// --- startAudit -----------------------------------------------------------------

describe('audit-session — startAudit', () => {
  it('starts at index 0 with no records', () => {
    const state = fresh();
    expect(state.currentIndex).toBe(0);
    expect(state.records).toEqual({});
    expect(state.scope).toHaveLength(3);
  });

  it('handles an empty scope without throwing', () => {
    const state = startAudit([]);
    const p = progress(state);
    expect(p.total).toBe(0);
    expect(p.current).toBeNull();
    expect(p.next).toBeNull();
    expect(p.fraction).toBe(0);
    expect(p.position).toBe(0);
    // An empty scope is NOT "complete" (there was nothing to do), so the caller
    // never flips straight to a summary for a zero-location audit.
    expect(p.isComplete).toBe(false);
  });
});

// --- markLocation (immutability + totals) ---------------------------------------

describe('audit-session — markLocation', () => {
  it('records a status without mutating the input state', () => {
    const before = fresh();
    const after = markLocation(before, 'a', 'counted');
    expect(statusOf(after, 'a')).toBe('counted');
    // Input untouched (pure reducer).
    expect(before.records).toEqual({});
    expect(statusOf(before, 'a')).toBe('pending');
  });

  it('defaults variance/adjustment totals to zero', () => {
    const state = markLocation(fresh(), 'a', 'skipped');
    expect(recordFor(state, 'a')).toEqual({ status: 'skipped', variancesFound: 0, adjustmentsMade: 0 });
  });

  it('captures variance and adjustment totals when supplied', () => {
    const state = markLocation(fresh(), 'b', 'reconciled', { variancesFound: 3, adjustmentsMade: 2 });
    expect(recordFor(state, 'b')).toEqual({ status: 'reconciled', variancesFound: 3, adjustmentsMade: 2 });
  });

  it('overwrites a prior record for the same location', () => {
    let state = markLocation(fresh(), 'a', 'counted', { variancesFound: 1 });
    state = markLocation(state, 'a', 'reconciled', { variancesFound: 1, adjustmentsMade: 1 });
    expect(recordFor(state, 'a')).toEqual({ status: 'reconciled', variancesFound: 1, adjustmentsMade: 1 });
  });
});

// --- Navigation: goToIndex / nextPendingIndex / advance / resumeAt --------------

describe('audit-session — navigation', () => {
  it('clamps goToIndex into range', () => {
    const state = fresh();
    expect(goToIndex(state, -5).currentIndex).toBe(0);
    expect(goToIndex(state, 1).currentIndex).toBe(1);
    expect(goToIndex(state, 99).currentIndex).toBe(2);
  });

  it('goToIndex on an empty scope stays at 0', () => {
    expect(goToIndex(startAudit([]), 3).currentIndex).toBe(0);
  });

  it('nextPendingIndex searches forward then wraps', () => {
    // Mark b done; from a (0) the next pending is c (2), skipping b.
    const state = markLocation(fresh(), 'b', 'counted');
    expect(nextPendingIndex(state, 0)).toBe(2);
    // From c (2) it wraps to a (0), still pending.
    expect(nextPendingIndex(state, 2)).toBe(0);
  });

  it('nextPendingIndex returns -1 when nothing is pending', () => {
    let state = fresh();
    for (const id of ['a', 'b', 'c']) state = markLocation(state, id, 'counted');
    expect(nextPendingIndex(state, 0)).toBe(-1);
  });

  it('advance moves to the next pending location', () => {
    let state = fresh(); // at a (0)
    state = markLocation(state, 'a', 'counted');
    state = advance(state);
    expect(state.currentIndex).toBe(1); // b
    state = markLocation(state, 'b', 'skipped');
    state = advance(state);
    expect(state.currentIndex).toBe(2); // c
  });

  it('advance leaves the index put when nothing remains pending', () => {
    let state = fresh();
    for (const id of ['a', 'b', 'c']) state = markLocation(state, id, 'counted');
    const advanced = advance(goToIndex(state, 1));
    expect(advanced.currentIndex).toBe(1);
  });

  it('advance past a middle-pending gap wraps back to it', () => {
    // b left pending; from a we do a, then advance -> b, then b done, advance from b -> wraps? No:
    // a done (0), c done (2), current at c: next pending wraps to b (1).
    let state = fresh();
    state = markLocation(state, 'a', 'counted');
    state = markLocation(state, 'c', 'counted');
    state = goToIndex(state, 2); // sitting on c
    expect(advance(state).currentIndex).toBe(1); // wraps to the still-pending b
  });

  it('firstPendingIndex finds the earliest pending, -1 when done', () => {
    let state = fresh();
    expect(firstPendingIndex(state)).toBe(0);
    state = markLocation(state, 'a', 'counted');
    expect(firstPendingIndex(state)).toBe(1);
    state = markLocation(state, 'b', 'skipped');
    state = markLocation(state, 'c', 'reconciled');
    expect(firstPendingIndex(state)).toBe(-1);
  });

  it('resumeAt lands on the first pending location', () => {
    let state = fresh();
    state = markLocation(state, 'a', 'counted');
    state = goToIndex(state, 2); // pretend the persisted index drifted to c
    expect(resumeAt(state).currentIndex).toBe(1); // resume on b, the first pending
  });

  it('resumeAt leaves a completed session unchanged', () => {
    let state = fresh();
    for (const id of ['a', 'b', 'c']) state = markLocation(state, id, 'counted');
    state = goToIndex(state, 2);
    expect(resumeAt(state).currentIndex).toBe(2);
  });
});

// --- progress -------------------------------------------------------------------

describe('audit-session — progress', () => {
  it('reports a fresh walk', () => {
    const p = progress(fresh());
    expect(p).toMatchObject({
      total: 3,
      done: 0,
      remaining: 3,
      currentIndex: 0,
      position: 1,
      fraction: 0,
      isComplete: false,
    });
    expect(p.current).toEqual({ id: 'a', name: 'Drawer A' });
    expect(p.next).toEqual({ id: 'b', name: 'Drawer B' }); // next pending after a
  });

  it('advances done / remaining / fraction as locations are recorded', () => {
    let state = markLocation(fresh(), 'a', 'reconciled', { variancesFound: 2, adjustmentsMade: 2 });
    let p = progress(state);
    expect(p.done).toBe(1);
    expect(p.remaining).toBe(2);
    expect(p.fraction).toBeCloseTo(1 / 3);
    expect(p.isComplete).toBe(false);

    state = markLocation(state, 'b', 'skipped');
    state = markLocation(state, 'c', 'counted');
    p = progress(state);
    expect(p.done).toBe(3);
    expect(p.remaining).toBe(0);
    expect(p.fraction).toBe(1);
    expect(p.isComplete).toBe(true);
    expect(p.next).toBeNull(); // nothing pending remains
  });

  it('position is the 1-based current index', () => {
    const state = goToIndex(fresh(), 2);
    expect(progress(state).position).toBe(3);
  });

  it('done counts terminal statuses regardless of walk order', () => {
    // Skipping and counting out of order still counts toward done.
    let state = fresh();
    state = markLocation(state, 'c', 'skipped');
    expect(progress(state).done).toBe(1);
  });
});

// --- summarise ------------------------------------------------------------------

describe('audit-session — summarise', () => {
  it('rolls up a mixed walk', () => {
    let state = fresh();
    state = markLocation(state, 'a', 'reconciled', { variancesFound: 3, adjustmentsMade: 2 });
    state = markLocation(state, 'b', 'counted', { variancesFound: 0, adjustmentsMade: 0 });
    state = markLocation(state, 'c', 'skipped');
    const s = summarise(state);
    expect(s).toMatchObject({
      locationsAudited: 2, // a (reconciled) + b (counted)
      locationsSkipped: 1, // c
      locationsWithVariances: 1, // only a had variances
      totalVariancesFound: 3,
      totalAdjustmentsMade: 2,
    });
    expect(s.skipped).toEqual([{ id: 'c', name: 'Drawer C' }]);
    expect(s.withVariances).toEqual([{ id: 'a', name: 'Drawer A' }]);
  });

  it('an all-clean walk reports zero variances and no skips', () => {
    let state = fresh();
    for (const id of ['a', 'b', 'c']) state = markLocation(state, id, 'counted');
    const s = summarise(state);
    expect(s.locationsAudited).toBe(3);
    expect(s.locationsSkipped).toBe(0);
    expect(s.locationsWithVariances).toBe(0);
    expect(s.totalVariancesFound).toBe(0);
    expect(s.totalAdjustmentsMade).toBe(0);
    expect(s.skipped).toEqual([]);
    expect(s.withVariances).toEqual([]);
  });

  it('a counted location that still carried variances is listed under withVariances', () => {
    // Edge: the auditor counted but chose not to authorise — variances found, none applied.
    const state = markLocation(fresh(), 'a', 'counted', { variancesFound: 2, adjustmentsMade: 0 });
    const s = summarise(state);
    expect(s.locationsWithVariances).toBe(1);
    expect(s.totalVariancesFound).toBe(2);
    expect(s.totalAdjustmentsMade).toBe(0);
    expect(s.withVariances).toEqual([{ id: 'a', name: 'Drawer A' }]);
  });
});

// --- Scope building over a tree -------------------------------------------------

const TREE: AuditTreeNode[] = [
  {
    id: 'workshop',
    name: 'Workshop',
    children: [
      { id: 'cabinet', name: 'Cabinet', children: [{ id: 'drawer', name: 'Drawer', children: [] }] },
      { id: 'shelf', name: 'Shelf', children: [] },
    ],
  },
  { id: 'garage', name: 'Garage', children: [] },
  { id: 'unassigned', name: 'Unassigned', isSystem: true, children: [] },
  {
    id: 'attic',
    name: 'Attic (archived)',
    archivedAt: 123,
    children: [{ id: 'attic-box', name: 'Box', children: [] }],
  },
];

describe('audit-session — collectAuditableInOrder', () => {
  it('flattens the tree pre-order, excluding system and archived branches', () => {
    const ids = collectAuditableInOrder(TREE).map((l) => l.id);
    expect(ids).toEqual(['workshop', 'cabinet', 'drawer', 'shelf', 'garage']);
    // system 'unassigned', archived 'attic' AND its child 'attic-box' are all dropped.
    expect(ids).not.toContain('unassigned');
    expect(ids).not.toContain('attic');
    expect(ids).not.toContain('attic-box');
  });

  it('carries the names through', () => {
    const scope = collectAuditableInOrder(TREE);
    expect(scope[0]).toEqual({ id: 'workshop', name: 'Workshop' });
  });

  it('returns an empty scope for an empty tree', () => {
    expect(collectAuditableInOrder([])).toEqual([]);
  });
});

describe('audit-session — buildScope', () => {
  it('mode "all" is every walkable location in order', () => {
    expect(buildScope(TREE, 'all').map((l) => l.id)).toEqual([
      'workshop',
      'cabinet',
      'drawer',
      'shelf',
      'garage',
    ]);
  });

  it('mode "subtree" is the anchor plus its descendants', () => {
    expect(buildScope(TREE, 'subtree', { anchorId: 'cabinet' }).map((l) => l.id)).toEqual([
      'cabinet',
      'drawer',
    ]);
  });

  it('mode "subtree" with no/absent anchor is empty', () => {
    expect(buildScope(TREE, 'subtree', {})).toEqual([]);
    expect(buildScope(TREE, 'subtree', { anchorId: null })).toEqual([]);
    expect(buildScope(TREE, 'subtree', { anchorId: 'nope' })).toEqual([]);
  });

  it('mode "subtree" anchored on an archived branch yields nothing', () => {
    // The anchor node itself is archived, so its subtree is pruned entirely.
    expect(buildScope(TREE, 'subtree', { anchorId: 'attic' })).toEqual([]);
  });

  it('mode "selected" keeps only chosen ids, in tree order', () => {
    const ids = new Set(['garage', 'drawer']);
    // Requested garage-then-drawer, but the result follows tree order (drawer before garage).
    expect(buildScope(TREE, 'selected', { selectedIds: ids }).map((l) => l.id)).toEqual(['drawer', 'garage']);
  });

  it('mode "selected" silently drops system/archived ids even if chosen', () => {
    const ids = new Set(['workshop', 'unassigned', 'attic-box']);
    expect(buildScope(TREE, 'selected', { selectedIds: ids }).map((l) => l.id)).toEqual(['workshop']);
  });

  it('mode "selected" with no ids is empty', () => {
    expect(buildScope(TREE, 'selected', {})).toEqual([]);
  });
});

describe('normaliseAuditSession', () => {
  const VALID = {
    scope: [
      { id: 'a', name: 'Shelf A' },
      { id: 'b', name: 'Shelf B' },
    ],
    currentIndex: 1,
    records: { a: { status: 'counted', variancesFound: 2, adjustmentsMade: 1 } },
  };

  it('round-trips a session that is already valid', () => {
    expect(normaliseAuditSession(VALID)).toEqual(VALID);
  });

  it.each([[null], [undefined], ['{}'], [42], [[]]])('reads %p as no session', (value) => {
    expect(normaliseAuditSession(value)).toBeNull();
  });

  it('reads a session with nothing walkable as no session', () => {
    // An empty scope can't be resumed, and every reducer here indexes `scope`.
    expect(normaliseAuditSession({ scope: [], currentIndex: 0, records: {} })).toBeNull();
    expect(normaliseAuditSession({ scope: 'Shelf A' })).toBeNull();
  });

  it('drops scope entries that are not a usable id/name pair', () => {
    const session = normaliseAuditSession({
      scope: [{ id: 'a', name: 'Shelf A' }, null, { id: '', name: 'Blank' }, { id: 'c' }, 'b'],
    });
    expect(session?.scope).toEqual([{ id: 'a', name: 'Shelf A' }]);
  });

  it('collapses duplicate ids so the walk visits each location once', () => {
    const session = normaliseAuditSession({
      scope: [
        { id: 'a', name: 'Shelf A' },
        { id: 'a', name: 'Shelf A (again)' },
      ],
    });
    expect(session?.scope).toEqual([{ id: 'a', name: 'Shelf A' }]);
  });

  it('clamps currentIndex into the reconciled scope', () => {
    expect(normaliseAuditSession({ ...VALID, currentIndex: 99 })?.currentIndex).toBe(1);
    expect(normaliseAuditSession({ ...VALID, currentIndex: -3 })?.currentIndex).toBe(0);
    expect(normaliseAuditSession({ ...VALID, currentIndex: 'two' })?.currentIndex).toBe(0);
  });

  it('discards records for locations no longer in scope', () => {
    const session = normaliseAuditSession({
      ...VALID,
      records: { ...VALID.records, gone: { status: 'skipped', variancesFound: 0, adjustmentsMade: 0 } },
    });
    expect(Object.keys(session!.records)).toEqual(['a']);
  });

  it('repairs a record with a bad status or counts rather than dropping the session', () => {
    const session = normaliseAuditSession({
      ...VALID,
      records: { a: { status: 'half-done', variancesFound: -4, adjustmentsMade: 'many' } },
    });
    expect(session?.records.a).toEqual({ status: 'pending', variancesFound: 0, adjustmentsMade: 0 });
  });

  it('does not conjure a record for an id that collides with an Object.prototype key', () => {
    const session = normaliseAuditSession({
      scope: [{ id: 'constructor', name: 'Shelf A' }],
      records: {},
    });
    expect(session?.records).toEqual({});
  });

  it('reads a non-object records map as no records', () => {
    expect(normaliseAuditSession({ ...VALID, records: 'nope' })?.records).toEqual({});
  });

  it('produces a session the pure seam can walk without throwing', () => {
    // The regression this guards: `progress` dereferences `scope[i].id`, so a truncated
    // persisted write used to throw on resume rather than degrade.
    const session = normaliseAuditSession({
      scope: [{ id: 'a', name: 'Shelf A' }, undefined, { id: 'b', name: 'Shelf B' }],
      currentIndex: 7,
      records: null,
    })!;
    const p = progress(session);
    expect(p.total).toBe(2);
    expect(p.current).toEqual({ id: 'b', name: 'Shelf B' });
    expect(() => resumeAt(session)).not.toThrow();
  });
});
