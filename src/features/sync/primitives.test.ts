import { describe, it, expect } from 'vitest';
import { computeClockOffset, applyOffset } from './clock';
import { resolveLww } from './lww';
import { mergeDeltas, replayGaugeValue, reconcileGauge } from './delta-crdt';
import { resolveLocationTarget, wouldCreateCycle } from './reparent';
import { sanitiseRow } from './schema-dictionary';
import { UNASSIGNED_LOCATION_ID } from '@/db/repositories';
import type { GaugeHistoryDelta } from './types';

describe('clock offset (§7.3)', () => {
  it('computes serverNow − localNow', () => {
    expect(computeClockOffset(1_000, 700)).toBe(300);
    expect(computeClockOffset(500, 900)).toBe(-400);
  });
  it('returns 0 when the server time is unknown', () => {
    expect(computeClockOffset(null, 700)).toBe(0);
    expect(computeClockOffset(Number.NaN, 700)).toBe(0);
  });
  it('applies the offset to a local timestamp', () => {
    expect(applyOffset(1_000, 300)).toBe(1_300);
  });
});

describe('LWW resolution (§7.3)', () => {
  it('local wins only when strictly newer (offset already applied)', () => {
    expect(resolveLww(200, 100)).toBe('LOCAL_WINS');
    expect(resolveLww(100, 200)).toBe('REMOTE_WINS');
  });
  it('ties go to the remote so a redundant re-sync is a no-op', () => {
    expect(resolveLww(100, 100)).toBe('REMOTE_WINS');
  });
});

describe('Delta-CRDT gauge replay (§7.3)', () => {
  const d = (id: string, delta: number, createdAt: number): GaugeHistoryDelta => ({
    id,
    itemId: 'spool',
    netValueDelta: delta,
    createdAt,
  });

  it('de-duplicates the same physical event by id', () => {
    const shared = d('h1', -45, 10);
    const merged = mergeDeltas([shared], [shared, d('h2', -10, 20)]);
    expect(merged.map((m) => m.id)).toEqual(['h1', 'h2']);
  });

  it('orders merged deltas chronologically', () => {
    const merged = mergeDeltas([d('b', -5, 30)], [d('a', -5, 10)]);
    expect(merged.map((m) => m.id)).toEqual(['a', 'b']);
  });

  it('replays concurrent offline usage from both devices', () => {
    // 1000 g spool: Device A used 45 g, Device B used 10 g → 945 g.
    const value = reconcileGauge(1000, [d('a', -45, 1)], [d('b', -10, 2)]);
    expect(value).toBe(945);
  });

  it('clamps below zero and above capacity', () => {
    expect(replayGaugeValue(100, [d('x', -250, 1)])).toBe(0);
    expect(replayGaugeValue(100, [d('x', 250, 1)])).toBe(100);
  });
});

describe('orphan re-parenting (§7.5.2)', () => {
  it('keeps a live target location', () => {
    const active = new Set(['loc-a']);
    expect(resolveLocationTarget('loc-a', active)).toEqual({
      locationId: 'loc-a',
      reparented: false,
    });
  });
  it('re-parents a missing/tombstoned target to Unassigned', () => {
    const res = resolveLocationTarget('gone', new Set<string>());
    expect(res).toEqual({ locationId: UNASSIGNED_LOCATION_ID, reparented: true });
  });
  it('always treats Unassigned itself as present', () => {
    expect(resolveLocationTarget(UNASSIGNED_LOCATION_ID, new Set()).reparented).toBe(false);
  });
});

describe('cyclical-nesting prevention (§7.5.3)', () => {
  it('detects a direct self-parent', () => {
    expect(wouldCreateCycle('x', 'x', new Map())).toBe(true);
  });
  it('detects an indirect cycle (X→Y while Y→X)', () => {
    // Y currently nests under X; moving X under Y closes the loop.
    const parentOf = new Map<string, string | null>([['y', 'x']]);
    expect(wouldCreateCycle('x', 'y', parentOf)).toBe(true);
  });
  it('allows a legal move to an unrelated parent', () => {
    const parentOf = new Map<string, string | null>([['y', null]]);
    expect(wouldCreateCycle('x', 'y', parentOf)).toBe(false);
  });
  it('treats a null parent (root) as never cyclic', () => {
    expect(wouldCreateCycle('x', null, new Map())).toBe(false);
  });
});

describe('schema-dictionary sanitisation (§7.3)', () => {
  it('strips keys the local schema does not have', () => {
    const clean = sanitiseRow(
      { id: '1', name: 'Widget', future_column: 'boom' },
      ['id', 'name'],
    );
    expect(clean).toEqual({ id: '1', name: 'Widget' });
  });
  it('keeps every allowed key, including nulls', () => {
    const clean = sanitiseRow({ id: '1', note: null }, ['id', 'note']);
    expect(clean).toEqual({ id: '1', note: null });
  });
});
