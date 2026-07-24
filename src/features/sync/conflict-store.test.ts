import { describe, it, expect, beforeEach } from 'vitest';
import { useSyncConflictsStore } from './conflict-store';
import { MAX_SYNC_CONFLICTS, SYNC_CONFLICT_TTL_MS } from './conflict-store-ops';
import { buildConflict } from './conflict-detect';
import type { SyncConflict } from './types';

// Freshly-detected by default: the store ages entries out relative to the real wall clock, so
// a fixed old timestamp would be dropped on add (#373).
function conflict(id: string, name = id, detectedAt = Date.now()): SyncConflict {
  return buildConflict(
    'contacts',
    { id, name, updated_at: 1 },
    { id, name: 'other', updated_at: 2 },
    detectedAt,
  );
}

describe('useSyncConflictsStore (#72)', () => {
  beforeEach(() => {
    useSyncConflictsStore.getState().clear();
  });

  it('adds conflicts, newest first', () => {
    useSyncConflictsStore.getState().add([conflict('a')]);
    useSyncConflictsStore.getState().add([conflict('b')]);
    expect(useSyncConflictsStore.getState().conflicts.map((c) => c.rowId)).toEqual(['b', 'a']);
  });

  it('de-duplicates by id (re-detecting the same discarded version)', () => {
    useSyncConflictsStore.getState().add([conflict('a')]);
    useSyncConflictsStore.getState().add([conflict('a'), conflict('c')]);
    expect(useSyncConflictsStore.getState().conflicts).toHaveLength(2);
  });

  it('adding an empty batch is a no-op that preserves the reference', () => {
    useSyncConflictsStore.getState().add([conflict('a')]);
    const before = useSyncConflictsStore.getState().conflicts;
    useSyncConflictsStore.getState().add([]);
    expect(useSyncConflictsStore.getState().conflicts).toBe(before);
  });

  it('resolve drops a single conflict; clear empties all', () => {
    useSyncConflictsStore.getState().add([conflict('a'), conflict('b')]);
    useSyncConflictsStore.getState().resolve('contacts:a:1');
    expect(useSyncConflictsStore.getState().conflicts.map((c) => c.rowId)).toEqual(['b']);
    useSyncConflictsStore.getState().clear();
    expect(useSyncConflictsStore.getState().conflicts).toHaveLength(0);
  });

  it('caps the backlog so localStorage never grows without bound (#373)', () => {
    const batch = Array.from({ length: MAX_SYNC_CONFLICTS + 25 }, (_, i) => conflict(`c-${i}`));
    useSyncConflictsStore.getState().add(batch);
    expect(useSyncConflictsStore.getState().conflicts).toHaveLength(MAX_SYNC_CONFLICTS);
  });

  it('ages a stale conflict out on add, keeping only the fresh one (#373)', () => {
    useSyncConflictsStore
      .getState()
      .add([conflict('fresh'), conflict('stale', 'stale', Date.now() - SYNC_CONFLICT_TTL_MS - 1)]);
    expect(useSyncConflictsStore.getState().conflicts.map((c) => c.rowId)).toEqual(['fresh']);
  });
});
