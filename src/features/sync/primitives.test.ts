import { describe, it, expect } from 'vitest';
import { computeClockOffset, applyOffset, measureClockOffset } from './clock';
import { resolveLww } from './lww';
import { mergeDeltas, replayGaugeValue, reconcileGauge } from './delta-crdt';
import { resolveLocationTarget, wouldCreateCycle } from './reparent';
import { sanitiseRow } from './schema-dictionary';
import { shiftSnapshotTimestamps } from './snapshot';
import { UNASSIGNED_LOCATION_ID } from '@/db/repositories';
import { SYNC_FORMAT_VERSION, type GaugeHistoryDelta, type SyncSnapshot } from './types';

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

describe('midpoint clock-offset measurement (§7.3.1)', () => {
  /** A `now` that returns each queued reading in turn, so a round-trip can be simulated. */
  function scriptedNow(readings: number[]): () => number {
    let i = 0;
    return () => readings[Math.min(i++, readings.length - 1)]!;
  }

  it('charges request latency to the midpoint, not the offset', async () => {
    // Local clock reads 1000 before the request and 1200 after (a 200ms round-trip). The server
    // stamps 1100 — exactly the midpoint — so the clocks actually agree and the offset must be 0,
    // not the −? a before-only reading would have produced.
    const m = await measureClockOffset(scriptedNow([1000, 1200]), async () => 1100);
    expect(m.offset).toBe(0);
    expect(m.serverNow).toBe(1100);
    expect(m.localNow).toBe(1200); // the freshest reading is used as "now"
  });

  it('still detects genuine skew on top of latency', async () => {
    // Same 200ms round-trip, but the server midpoint-equivalent is 1150 → a real +50ms skew.
    const m = await measureClockOffset(scriptedNow([1000, 1200]), async () => 1150);
    expect(m.offset).toBe(50);
  });

  it('reports a zero offset (and local now) when the source has no clock', async () => {
    const m = await measureClockOffset(scriptedNow([1000, 1010]), async () => null);
    expect(m).toEqual({ offset: 0, serverNow: null, localNow: 1010 });
  });
});

describe('snapshot timestamp shift (§7.3.1 local⇄server frame)', () => {
  const snap = (): SyncSnapshot => ({
    formatVersion: SYNC_FORMAT_VERSION,
    generatedAt: 0,
    tables: {
      items: [{ id: 'a', updated_at: 1000, created_at: 500 }],
      locations: [{ id: 'l', updated_at: 2000 }],
    },
    tombstones: [{ tableName: 'items', id: 'z', deletedAt: 3000 }],
    gaugeHistory: [{ id: 'g', itemId: 'a', netValueDelta: -5, createdAt: 700 }],
    itemTags: [{ itemId: 'a', tagId: 't' }],
    itemHistory: [{ id: 'h', item_id: 'a', created_at: 800 }],
  });

  it('shifts only updated_at and tombstone deletedAt, leaving other timestamps alone', () => {
    const out = shiftSnapshotTimestamps(snap(), 100);
    expect(out.tables.items![0]!.updated_at).toBe(1100);
    expect(out.tables.locations![0]!.updated_at).toBe(2100);
    expect(out.tombstones[0]!.deletedAt).toBe(3100);
    // created_at, gauge/item-history and tag edges are resolved without LWW timestamps — untouched.
    expect(out.tables.items![0]!.created_at).toBe(500);
    expect(out.gaugeHistory[0]!.createdAt).toBe(700);
    expect(out.itemHistory[0]!.created_at).toBe(800);
  });

  it('round-trips: +offset then −offset restores the original', () => {
    const original = snap();
    const restored = shiftSnapshotTimestamps(shiftSnapshotTimestamps(original, 250), -250);
    expect(restored.tables.items![0]!.updated_at).toBe(1000);
    expect(restored.tombstones[0]!.deletedAt).toBe(3000);
  });

  it('returns the snapshot unchanged for a zero offset (no server clock)', () => {
    const original = snap();
    expect(shiftSnapshotTimestamps(original, 0)).toBe(original);
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
    const clean = sanitiseRow({ id: '1', name: 'Widget', future_column: 'boom' }, ['id', 'name']);
    expect(clean).toEqual({ id: '1', name: 'Widget' });
  });
  it('keeps every allowed key, including nulls', () => {
    const clean = sanitiseRow({ id: '1', note: null }, ['id', 'note']);
    expect(clean).toEqual({ id: '1', note: null });
  });
});
