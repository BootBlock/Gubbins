/**
 * Issue #542 — `checkouts.returned_at` is write-once, so `resolveLoanReturnConflicts` merges it
 * monotonically: where one device's copy of a loan is closed and the other's is open, the return
 * is what stands, whichever row last-write-wins would have picked.
 *
 * The repair must lift the return onto the row the merge has already **settled**, never resurrect
 * the pre-merge row in its place. Earlier passes write to that same upsert — most consequentially
 * `resolveUniqueKeyCollisions`, which repoints a `contact_id` whose contact lost a `name` collision
 * and is about to be deleted. Putting the raw row back restores the retired id, and the atomic
 * apply then aborts on its foreign key, taking every other change in the merge with it — on every
 * sync from then on, exactly the bricked-sync failure issue #187 exists to prevent.
 */
import { describe, it, expect } from 'vitest';
import { reconcile } from './reconcile';
import type { SqlRow } from '@/db/rpc/driver';
import type { SyncSnapshot } from './types';

const DICTIONARY = {
  items: ['id', 'name', 'tracking_mode', 'location_id', 'updated_at'],
  contacts: ['id', 'name', 'updated_at'],
  checkouts: [
    'id',
    'item_id',
    'contact_id',
    'quantity',
    'checked_out_at',
    'returned_at',
    'returned_quantity',
    'return_note',
    'updated_at',
  ],
};

function snapshot(tables: Partial<Record<string, SqlRow[]>>): SyncSnapshot {
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

const ITEM: SqlRow = { id: 'i1', name: 'Dumpy level', tracking_mode: 'DISCRETE', updated_at: 1 };

/** The loan, as one device holds it. `x` is the borrower whose contact loses the name collision. */
function loan(overrides: Partial<SqlRow>): SqlRow {
  return {
    id: 'k1',
    item_id: 'i1',
    contact_id: 'x',
    quantity: 1,
    returned_quantity: 0,
    checked_out_at: 1,
    returned_at: null,
    return_note: null,
    updated_at: 100,
    ...overrides,
  };
}

const opts = { offset: 0, dictionary: DICTIONARY };

/** The `checkouts` row the plan will upsert, if any. */
function checkoutUpsert(plan: ReturnType<typeof reconcile>): SqlRow | undefined {
  return plan.localUpserts.find((u) => u.table === 'checkouts')?.row;
}

describe('issue #542 — preserving a return without undoing the merge', () => {
  // Contact `x` (the borrower) loses the name "Ada" to `y`, so `x` is retired and deleted and the
  // loan must follow the winner. The local copy of the loan is open and newer; the remote is closed.
  const local = snapshot({
    items: [ITEM],
    contacts: [
      { id: 'x', name: 'Xena', updated_at: 1 },
      { id: 'y', name: 'Ada', updated_at: 70 },
    ],
    // Checked out later than the remote's copy — the two devices each opened this loan, so the
    // stamps differ, and a return lifted onto the wrong one would fail the schema's
    // `returned_at >= checked_out_at` CHECK and abort the merge.
    checkouts: [loan({ checked_out_at: 800, updated_at: 900 })],
  });
  const remote = snapshot({
    items: [ITEM],
    contacts: [
      { id: 'x', name: 'Ada', updated_at: 60 },
      { id: 'y', name: 'Yara', updated_at: 1 },
    ],
    checkouts: [
      loan({ returned_at: 500, returned_quantity: 1, return_note: 'back on the shelf', updated_at: 500 }),
    ],
  });

  it('keeps the return and the re-pointed borrower together', () => {
    const plan = reconcile(local, remote, opts);

    // The collision retires `x`, so anything still pointing at it would fail the apply's FK.
    expect(plan.collisions).toEqual([{ table: 'contacts', loserId: 'x', winnerId: 'y', deletedAt: 70 }]);
    expect(plan.loanReturnsPreserved).toEqual([{ itemId: 'i1', checkoutId: 'k1' }]);

    const row = checkoutUpsert(plan);
    expect(row?.contact_id).toBe('y'); // the merge's own re-point survives the repair
    expect(row?.returned_at).toBe(500); // …and so does the return it was repairing
    expect(row?.return_note).toBe('back on the shelf');
    expect(row?.checked_out_at).toBe(1); // the closed copy's, so the CHECK on the pair still holds
    expect(Number(row?.returned_at)).toBeGreaterThanOrEqual(Number(row?.checked_out_at));
    expect(row?.updated_at).toBe(501); // the closed copy's stamp +1 — frame-stable on both devices
  });

  it('does not also report the preserved return as a lost edit', () => {
    // Detection runs before the repair, so every column the repair carries across must be excused
    // from it — otherwise the sync tells the user an edit was overwritten on the very row whose
    // distinguishing values it has just preserved, and "Use my version" rewrites half the repair.
    const plan = reconcile(local, remote, { ...opts, conflictSince: 1, now: 5000 });

    expect(plan.loanReturnsPreserved).toEqual([{ itemId: 'i1', checkoutId: 'k1' }]);
    expect(plan.conflicts.filter((c) => c.tableName === 'checkouts')).toEqual([]);
  });

  it('leaves an uncontested return alone, re-pointing it exactly as any other row', () => {
    // Same collision, but both copies agree the loan is still open — nothing for the repair to do.
    const openRemote = snapshot({ ...remote.tables, checkouts: [loan({ updated_at: 500 })] });
    const plan = reconcile(local, openRemote, opts);

    expect(plan.loanReturnsPreserved).toEqual([]);
    expect(checkoutUpsert(plan)?.contact_id).toBe('y');
    expect(checkoutUpsert(plan)?.returned_at).toBeNull();
  });
});

/**
 * Issue #662 — `checkouts.returned_quantity` is the same monotonic column one step earlier. A loan
 * lent in quantity comes back in instalments, and each instalment has already put its units on the
 * shelf by the time the counter records them. So a peer's newer copy winning the row outright must
 * not rewind it: that would say units are still with the borrower while the stock ledger says they
 * are back, which is the stranded-stock failure #542 exists to prevent, before the loan closes.
 */
describe('issue #662 — preserving a partial return', () => {
  const ITEM6: SqlRow = { id: 'i1', name: 'Drill bit', tracking_mode: 'DISCRETE', updated_at: 1 };

  function six(overrides: Partial<SqlRow>): SqlRow {
    return loan({ contact_id: 'y', quantity: 6, ...overrides });
  }

  const contacts = [{ id: 'y', name: 'Ada', updated_at: 1 }];

  it('takes the higher instalment count when neither copy has closed the loan', () => {
    // This device recorded two of the six coming back. The peer's copy is untouched but NEWER, so
    // plain last-write-wins would settle on a loan with nothing returned.
    const local = snapshot({
      items: [ITEM6],
      contacts,
      checkouts: [six({ returned_quantity: 2, updated_at: 100 })],
    });
    const remote = snapshot({
      items: [ITEM6],
      contacts,
      checkouts: [six({ returned_quantity: 0, updated_at: 900 })],
    });

    const plan = reconcile(local, remote, opts);
    const row = checkoutUpsert(plan);

    expect(row?.returned_quantity).toBe(2);
    expect(row?.returned_at).toBeNull(); // four are still out — the loan has not closed
    expect(plan.loanReturnsPreserved).toEqual([{ itemId: 'i1', checkoutId: 'k1' }]);
  });

  it('leaves two copies that agree about the count untouched', () => {
    const local = snapshot({
      items: [ITEM6],
      contacts,
      checkouts: [six({ returned_quantity: 2, updated_at: 100 })],
    });
    const remote = snapshot({
      items: [ITEM6],
      contacts,
      checkouts: [six({ returned_quantity: 2, updated_at: 900 })],
    });

    expect(reconcile(local, remote, opts).loanReturnsPreserved).toEqual([]);
  });

  it('carries the higher count across when the other copy closes the loan', () => {
    // The peer closed the loan without ever seeing this device's instalment, so its counter reads
    // the whole six; taking the max is what stops the closure repair rewinding either side.
    const local = snapshot({
      items: [ITEM6],
      contacts,
      checkouts: [six({ returned_quantity: 2, updated_at: 900 })],
    });
    const remote = snapshot({
      items: [ITEM6],
      contacts,
      checkouts: [six({ returned_quantity: 6, returned_at: 500, updated_at: 500 })],
    });

    const row = checkoutUpsert(reconcile(local, remote, opts));
    expect(row?.returned_at).toBe(500);
    expect(row?.returned_quantity).toBe(6);
  });

  it('never writes a count above the units the loan lent out', () => {
    // Half the pair is a downloaded row. A snapshot claiming more returned than was ever lent
    // would build an upsert that fails the column's CHECK — and the apply is atomic, so one
    // crafted row would abort every other change in the merge, on this and every later sync.
    const local = snapshot({
      items: [ITEM6],
      contacts,
      checkouts: [six({ returned_quantity: 0, updated_at: 900 })],
    });
    const remote = snapshot({
      items: [ITEM6],
      contacts,
      checkouts: [six({ returned_quantity: 9999, updated_at: 100 })],
    });

    expect(checkoutUpsert(reconcile(local, remote, opts))?.returned_quantity).toBe(6);
  });

  it('does not report the preserved instalment as a lost edit', () => {
    const local = snapshot({
      items: [ITEM6],
      contacts,
      checkouts: [six({ returned_quantity: 2, updated_at: 100 })],
    });
    const remote = snapshot({
      items: [ITEM6],
      contacts,
      checkouts: [six({ returned_quantity: 0, updated_at: 900 })],
    });

    const plan = reconcile(local, remote, { ...opts, conflictSince: 1, now: 5000 });
    expect(plan.conflicts.filter((c) => c.tableName === 'checkouts')).toEqual([]);
  });
});
