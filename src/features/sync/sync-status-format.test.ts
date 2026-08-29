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
    serialisedLoansClosed: 0,
    loanReturnsPreserved: 0,
    loanInstalmentsPreserved: 0,
    bookingsCancelled: 0,
    kitLinksBroken: 0,
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
    expect(withExtras).toContain('1 nesting change skipped to avoid a loop');
  });

  it('flags a serialised item closed because it was already on loan elsewhere (#193)', () => {
    const plain = describeSyncOutcome(makeResult({ status: 'SYNCED' }));
    expect(plain).not.toMatch(/duplicate loan/);

    expect(describeSyncOutcome(makeResult({ serialisedLoansClosed: 1 }))).toContain(
      '1 duplicate loan closed (an item was already checked out elsewhere).',
    );
    expect(describeSyncOutcome(makeResult({ serialisedLoansClosed: 2 }))).toContain(
      '2 duplicate loans closed',
    );
  });

  it('tells a returned loan kept closed apart from a part-returned one kept counted (#542, #662)', () => {
    const plain = describeSyncOutcome(makeResult({ status: 'SYNCED' }));
    expect(plain).not.toMatch(/kept closed|returned count/);

    // A loan the merge would have re-opened. Something genuinely came back.
    const closed = describeSyncOutcome(makeResult({ loanReturnsPreserved: 1 }));
    expect(closed).toContain('1 returned loan kept closed (it was still checked out elsewhere).');
    expect(closed).not.toMatch(/returned count/);

    // A loan handed back in part. NOTHING was closed, so it must not claim a loan came back —
    // it is still out with the borrower, and only the count of what is back was preserved.
    const partial = describeSyncOutcome(makeResult({ loanInstalmentsPreserved: 1 }));
    expect(partial).toContain(
      '1 part-returned loan kept its returned count (another device had fewer back).',
    );
    expect(partial).not.toMatch(/kept closed/);
    expect(describeSyncOutcome(makeResult({ loanInstalmentsPreserved: 2 }))).toContain(
      '2 part-returned loans kept their returned count',
    );
  });

  it('flags a booking cancelled because the asset was already booked for those dates elsewhere (#194)', () => {
    const plain = describeSyncOutcome(makeResult({ status: 'SYNCED' }));
    expect(plain).not.toMatch(/overlapping booking/);

    expect(describeSyncOutcome(makeResult({ bookingsCancelled: 1 }))).toContain(
      '1 overlapping booking cancelled (an asset was already booked for those dates elsewhere).',
    );
    expect(describeSyncOutcome(makeResult({ bookingsCancelled: 2 }))).toContain(
      '2 overlapping bookings cancelled',
    );
  });

  it('flags a kit link removed because the merge would have put a kit inside itself (#539)', () => {
    const plain = describeSyncOutcome(makeResult({ status: 'SYNCED' }));
    expect(plain).not.toMatch(/kit component link/);

    expect(describeSyncOutcome(makeResult({ kitLinksBroken: 1 }))).toContain(
      '1 kit component link removed (it would have put a kit inside itself).',
    );
    expect(describeSyncOutcome(makeResult({ kitLinksBroken: 2 }))).toContain('2 kit component links removed');
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

  it('says the merge landed but the publish did not, rather than "sync failed" (#638)', () => {
    // The half-completed pass: local data *has* changed, so the copy must not read as
    // "nothing happened" — and it still has to report what it brought in.
    const quiet = describeSyncOutcome(makeResult({ status: 'MERGED_NOT_PUBLISHED' }));
    expect(quiet).toBe(
      'Merged on this device, but publishing to the sync location failed — your changes will publish next time you sync.',
    );

    const withChanges = describeSyncOutcome(
      makeResult({ status: 'MERGED_NOT_PUBLISHED', pulled: 3, deleted: 1 }),
    );
    expect(withChanges).toContain('brought in 3 updates and removed 1 item');
    expect(withChanges).toContain('publishing to the sync location failed');
    expect(withChanges).not.toMatch(/^Synced/);
  });

  it('still flags overwritten edits when the publish failed (#638)', () => {
    // The whole point of carrying the outcome out on the error: these are unrecoverable
    // otherwise, so they must be as visible here as on a completed sync.
    const text = describeSyncOutcome(
      makeResult({
        status: 'MERGED_NOT_PUBLISHED',
        conflicts: [
          {
            id: 'x',
            tableName: 'contacts',
            rowId: 'x',
            kind: 'UPDATE',
            localVersion: { id: 'x' },
            remoteVersion: { id: 'x' },
            entityLabel: 'x',
            detectedAt: 1,
          },
        ],
      }),
    );
    expect(text).toContain('1 of your edits was overwritten — review to keep or restore it.');
  });

  it('passes a HARD_STOP message through', () => {
    expect(describeSyncOutcome(makeResult({ status: 'HARD_STOP', message: 'Storage nearly full.' }))).toBe(
      'Storage nearly full.',
    );
  });
});
