import { describe, it, expect } from 'vitest';
import { mergeConflicts, MAX_SYNC_CONFLICTS, SYNC_CONFLICT_TTL_MS } from './conflict-store-ops';
import { buildConflict } from './conflict-detect';
import type { SyncConflict } from './types';

const NOW = 1_000_000_000_000;

/** A conflict on row `id`, detected at `detectedAt` (defaults to NOW). */
function conflict(id: string, detectedAt = NOW): SyncConflict {
  return buildConflict(
    'contacts',
    { id, name: id, updated_at: 1 },
    { id, name: 'won', updated_at: 2 },
    detectedAt,
  );
}

describe('mergeConflicts (#373)', () => {
  it('places incoming ahead of the existing backlog, newest first', () => {
    const existing = [conflict('a')];
    const merged = mergeConflicts(existing, [conflict('b')], NOW);
    expect(merged.map((c) => c.rowId)).toEqual(['b', 'a']);
  });

  it('de-duplicates by id, keeping the first-seen (incoming) copy', () => {
    const existing = [conflict('a'), conflict('c')];
    const merged = mergeConflicts(existing, [conflict('a')], NOW);
    expect(merged.map((c) => c.rowId)).toEqual(['a', 'c']);
    expect(merged).toHaveLength(2);
  });

  it('drops conflicts older than the TTL by detectedAt', () => {
    const fresh = conflict('fresh', NOW);
    const stale = conflict('stale', NOW - SYNC_CONFLICT_TTL_MS - 1);
    const merged = mergeConflicts([stale], [fresh], NOW);
    expect(merged.map((c) => c.rowId)).toEqual(['fresh']);
  });

  it('keeps a conflict exactly at the TTL boundary', () => {
    const edge = conflict('edge', NOW - SYNC_CONFLICT_TTL_MS);
    const merged = mergeConflicts([], [edge], NOW);
    expect(merged.map((c) => c.rowId)).toEqual(['edge']);
  });

  it('caps the backlog at MAX_SYNC_CONFLICTS, dropping the oldest', () => {
    const existing = Array.from({ length: MAX_SYNC_CONFLICTS }, (_, i) => conflict(`old-${i}`));
    const merged = mergeConflicts(existing, [conflict('new')], NOW);
    expect(merged).toHaveLength(MAX_SYNC_CONFLICTS);
    expect(merged[0].rowId).toBe('new');
    // The single oldest (tail) entry was dropped to make room.
    expect(merged.some((c) => c.rowId === `old-${MAX_SYNC_CONFLICTS - 1}`)).toBe(false);
  });

  it('re-adding an already-present id leaves the backlog unchanged in content', () => {
    const existing = [conflict('a'), conflict('b')];
    const merged = mergeConflicts(existing, [conflict('a')], NOW);
    expect(merged.map((c) => c.rowId)).toEqual(['a', 'b']);
  });

  it('prunes an already-stale backlog even when the incoming batch is empty', () => {
    const stale = conflict('stale', NOW - SYNC_CONFLICT_TTL_MS - 1);
    const merged = mergeConflicts([stale], [], NOW);
    expect(merged).toHaveLength(0);
  });
});
