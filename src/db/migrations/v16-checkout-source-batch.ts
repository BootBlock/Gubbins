import type { Migration } from './migration';

/**
 * v16 — Explicit per-batch checkout source (spec §4 "Borrowing & Checking Out" +
 * perishables/Batch-Lot, Phase 29).
 *
 * Phase 26 let a loan be drawn from a specific *location* and return there (the v14
 * `checkouts.source_location_id`); Phase 28 made a placement's units splittable across
 * distinct *batches*, but a loan still auto-consumed FEFO and a return restored to the
 * placement's untracked default batch — the lot a unit came from was forgotten. Phase 29
 * lets the borrower pick the exact lot, and a faithful per-batch ledger must return those
 * units to *that lot*, not anonymise them.
 *
 * That requires remembering the lent-from batch on the borrow record, so this single
 * additive, **nullable** column records its canonical batch key (the `stock_batches.batch_key`,
 * empty `''` for the untracked default). NULL means "no specific lot" — the Phase-28 behaviour
 * (return to the source placement's untracked default batch), so every existing checkout reads
 * correctly with no backfill. It is *not* a foreign key: a batch key is a synthetic identity,
 * the lot's `stock_batches` row may legitimately be emptied (set to 0) while the unit is out,
 * and the canonical key round-trips back to its identity via `batchIdentityFromKey` so the
 * return re-creates the exact lot wherever it is restored — no FK_REFS / re-home is needed.
 *
 * `checkouts` is already in `SYNC_TABLES` and the LWW schema dictionary reads its columns live
 * via `PRAGMA table_info`, so the new column round-trips across devices with no further
 * registration — the lent-from lot should sync, so it is deliberately *not* added to
 * `SYNC_EXCLUDED_COLUMNS`. (A nullable `ADD COLUMN` with no `REFERENCES` clause needs no §2.3.3
 * table recreation.)
 */
export const v16CheckoutSourceBatch: Migration = {
  version: 16,
  name: 'checkout-source-batch',
  statements: [
    {
      sql: `ALTER TABLE checkouts ADD COLUMN source_batch_key TEXT;`,
    },
  ],
};
