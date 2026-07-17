import { describe, it, expect } from 'vitest';
import { describeSyncOutcome } from './sync-status-format';
import type { SyncResult } from './sync-engine';

/** A zero-count SYNCED result; spread to override individual fields per case. */
function makeResult(overrides: Partial<SyncResult> = {}): SyncResult {
  return {
    status: 'SYNCED',
    pulled: 0,
    deleted: 0,
    reparented: 0,
    rejectedCycles: 0,
    prunedTombstones: 0,
    clockOffset: 0,
    historyInserted: 0,
    tagEdgesAdded: 0,
    tagEdgesRemoved: 0,
    conflicts: [],
    ...overrides,
  };
}

describe('describeSyncOutcome', () => {
  it('describes a first publish reassuringly (no "pulled 0 · deleted 0" jargon)', () => {
    const text = describeSyncOutcome(makeResult({ status: 'PUBLISHED' }));
    expect(text).toMatch(/^Published —/);
    expect(text).not.toMatch(/pulled|deleted 0|PUBLISHED/);
  });

  it('describes an unchanged two-way sync as "Up to date"', () => {
    expect(describeSyncOutcome(makeResult({ status: 'SYNCED' }))).toBe(
      'Up to date — published your changes; nothing new to bring in.',
    );
  });

  it('summarises pulled and deleted counts in words, with correct pluralisation', () => {
    expect(describeSyncOutcome(makeResult({ pulled: 1, deleted: 0 }))).toBe('Synced — brought in 1 update.');
    expect(describeSyncOutcome(makeResult({ pulled: 3, deleted: 2 }))).toBe(
      'Synced — brought in 3 updates and removed 2 items.',
    );
    expect(describeSyncOutcome(makeResult({ pulled: 0, deleted: 1 }))).toBe('Synced — removed 1 item.');
  });

  it('describes a full re-clone', () => {
    expect(describeSyncOutcome(makeResult({ status: 'CLONED' }))).toMatch(/^Re-synced —/);
  });

  it('appends re-parenting and cycle-avoidance only when they occur', () => {
    const plain = describeSyncOutcome(makeResult({ status: 'SYNCED' }));
    expect(plain).not.toMatch(/Unassigned|loop/);

    const withExtras = describeSyncOutcome(makeResult({ pulled: 1, reparented: 2, rejectedCycles: 1 }));
    expect(withExtras).toContain('brought in 1 update');
    expect(withExtras).toContain('2 items moved to Unassigned');
    expect(withExtras).toContain('1 location move skipped to avoid a loop');
  });

  it('flags overwritten local edits for review (#72), with correct pluralisation', () => {
    const c = (id: string) => ({
      id,
      tableName: 'contacts' as const,
      rowId: id,
      kind: 'UPDATE' as const,
      localVersion: { id },
      remoteVersion: { id },
      entityLabel: id,
      detectedAt: 1,
    });
    expect(describeSyncOutcome(makeResult({ conflicts: [c('a')] }))).toContain(
      '1 of your edits was overwritten — review to keep or restore it.',
    );
    expect(describeSyncOutcome(makeResult({ conflicts: [c('a'), c('b')] }))).toContain(
      '2 of your edits were overwritten — review to keep or restore them.',
    );
  });

  it('passes a HARD_STOP message through', () => {
    expect(describeSyncOutcome(makeResult({ status: 'HARD_STOP', message: 'Storage nearly full.' }))).toBe(
      'Storage nearly full.',
    );
  });
});
