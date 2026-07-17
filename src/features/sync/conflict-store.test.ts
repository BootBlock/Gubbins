import { describe, it, expect, beforeEach } from 'vitest';
import { useSyncConflictsStore } from './conflict-store';
import { buildConflict } from './conflict-detect';
import type { SyncConflict } from './types';

function conflict(id: string, name = id): SyncConflict {
  return buildConflict('contacts', { id, name, updated_at: 1 }, { id, name: 'other', updated_at: 2 }, 100);
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
});
