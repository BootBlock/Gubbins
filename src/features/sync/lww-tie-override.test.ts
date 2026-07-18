import { describe, it, expect } from 'vitest';
import type { SqlRow } from '@/db/rpc/driver';
import { forceLwwTies } from './lww-tie-override';
import type { SyncSnapshot } from './types';

function snapshot(tables: Record<string, SqlRow[]>): SyncSnapshot {
  return {
    formatVersion: 1,
    generatedAt: 0,
    tables,
    tombstones: [],
    gaugeHistory: [],
    itemTags: [],
    locationTags: [],
    itemHistory: [],
  };
}

describe('forceLwwTies (`sync-lww-tie` lab flag)', () => {
  it('rewrites a shared row’s remote updated_at to match the local one', () => {
    const local = snapshot({ items: [{ id: 'a', name: 'Widget', updated_at: 5000 }] });
    const remote = snapshot({ items: [{ id: 'a', name: 'Widget', updated_at: 100 }] });

    const result = forceLwwTies(local, remote);

    expect(result.tables.items).toEqual([{ id: 'a', name: 'Widget', updated_at: 5000 }]);
  });

  it('leaves a row present only on the remote untouched', () => {
    const local = snapshot({ items: [] });
    const remote = snapshot({ items: [{ id: 'b', name: 'New', updated_at: 100 }] });

    const result = forceLwwTies(local, remote);

    expect(result.tables.items).toEqual([{ id: 'b', name: 'New', updated_at: 100 }]);
  });

  it('leaves an already-tied row unchanged (no gratuitous copy)', () => {
    const row: SqlRow = { id: 'a', name: 'Widget', updated_at: 100 };
    const local = snapshot({ items: [row] });
    const remote = snapshot({ items: [{ ...row }] });

    const result = forceLwwTies(local, remote);

    expect(result.tables.items![0]).toEqual(row);
  });

  it('does not mutate either input snapshot', () => {
    const local = snapshot({ items: [{ id: 'a', name: 'Widget', updated_at: 5000 }] });
    const remote = snapshot({ items: [{ id: 'a', name: 'Widget', updated_at: 100 }] });
    const remoteBefore = JSON.parse(JSON.stringify(remote));

    forceLwwTies(local, remote);

    expect(remote).toEqual(remoteBefore);
  });

  it('handles multiple tables, only rewriting rows that exist on both sides', () => {
    const local = snapshot({
      items: [{ id: 'a', updated_at: 5000 }],
      locations: [{ id: 'loc-1', updated_at: 9000 }],
    });
    const remote = snapshot({
      items: [{ id: 'a', updated_at: 100 }],
      locations: [{ id: 'loc-2', updated_at: 200 }], // different id — not shared
    });

    const result = forceLwwTies(local, remote);

    expect(result.tables.items).toEqual([{ id: 'a', updated_at: 5000 }]);
    expect(result.tables.locations).toEqual([{ id: 'loc-2', updated_at: 200 }]);
  });
});
