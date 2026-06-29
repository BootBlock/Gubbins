import type { Migration } from './migration';

/**
 * v14 — Per-location checkout source (spec §4 "Borrowing & Checking Out", Phase 26).
 *
 * Phase 25 made `item_stock` the SSOT for *where* an item's units sit, but a loan still
 * decremented (and a return still restored) the item's *primary* placement. Phase 26 lets
 * a loan be drawn from a *specific* location — and a faithful per-location ledger must
 * return those units to *where they left from*, not to an arbitrary primary placement.
 *
 * That requires remembering the lend-from location on the borrow record, so this single
 * additive, **nullable** column records it. NULL means "no specific source" — the
 * pre-Phase-26 behaviour (default to the item's primary location), so every existing
 * checkout reads correctly with no backfill. A nullable FK to `locations` (NO ACTION /
 * RESTRICT, like every other location reference) keeps it referentially honest; the
 * local `LocationRepository.delete` and the §7.5.2 sync `applyPlan` both null it out for
 * a removed location before the location's tombstone DELETE, and the sync `FK_REFS` guard
 * nulls an *incoming* checkout whose source location did not survive the merge.
 *
 * `checkouts` is already in `SYNC_TABLES` and the LWW schema dictionary reads its columns
 * live via `PRAGMA table_info`, so the new column round-trips across devices with no
 * further registration — the lend-from location should sync, so it is deliberately *not*
 * added to `SYNC_EXCLUDED_COLUMNS`. (SQLite permits an `ADD COLUMN` carrying a `REFERENCES`
 * clause only when its default is NULL, which a nullable column satisfies — no §2.3.3
 * 12-step table recreation is needed.)
 */
export const v14CheckoutSourceLocation: Migration = {
  version: 14,
  name: 'checkout-source-location',
  statements: [
    {
      sql: `ALTER TABLE checkouts ADD COLUMN source_location_id TEXT REFERENCES locations(id);`,
    },
  ],
};
