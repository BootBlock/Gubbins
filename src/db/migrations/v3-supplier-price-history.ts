import { SQL_NOW_MS, type Migration } from './migration';

/**
 * v3 — Supplier price-history tracking (Phase 81, third feature-gap audit Wave 3 add-on
 * #7 — the LAST candidate of that audit). The second forward migration after the
 * Phase-69 v1 squash, following the Phase-78 v2 `asset_bookings` step.
 *
 * A supplier part's `supplier_parts.unit_cost` is editable manually and filled by a
 * supplier scrape, but both paths simply **overwrite** the previous value — so a part's
 * price movement over time was lost. This adds a lightweight append-only history row per
 * genuine cost change (deduped against the previous value, tagged by `source` and the
 * cost's `currency`), so the UI can show how a part's price has moved.
 *
 * ## Additive & forward — no local-DB wipe
 * An ordinary forward step: the engine applies only migrations whose version exceeds the
 * on-disk `user_version`, so an existing v2 database upgrades to v3 by simply creating the
 * new table — no existing table is touched and no data moves.
 *
 * ## Sync wiring (a price-history row is a real synced row, §7.1 LWW)
 * The table carries its own `updated_at` + the canonical auto-stamp trigger, so once it is
 * listed in `SYNC_TABLES` (after `supplier_parts`, its FK parent) it resolves by the same
 * row-level Last-Write-Wins as every other entity table; its `supplier_part_id` FK
 * (ON DELETE CASCADE, NOT NULL) gets its `FK_REFS` guard in the reconcile engine. Rows are
 * insert-only in practice, so LWW is degenerate — each row syncs once and never updates.
 */
export const v3SupplierPriceHistory: Migration = {
  version: 3,
  name: 'supplier-price-history',
  statements: [
    {
      sql: `
        CREATE TABLE supplier_part_price_history (
          id               TEXT    PRIMARY KEY NOT NULL,
          supplier_part_id TEXT    NOT NULL REFERENCES supplier_parts(id) ON DELETE CASCADE,
          unit_cost        REAL    NOT NULL,                  -- the recorded cost at recorded_at
          currency         TEXT,                              -- null ⇒ base currency
          source           TEXT    NOT NULL DEFAULT 'MANUAL', -- 'MANUAL' | 'SCRAPE'
          recorded_at      INTEGER NOT NULL DEFAULT (${SQL_NOW_MS}),
          updated_at       INTEGER NOT NULL DEFAULT (${SQL_NOW_MS}),
          CHECK (unit_cost >= 0),
          CHECK (source IN ('MANUAL', 'SCRAPE'))
        ) STRICT;
      `,
    },
    {
      sql: `CREATE INDEX idx_supplier_part_price_history_part
              ON supplier_part_price_history(supplier_part_id, recorded_at);`,
    },
    {
      sql: `
        CREATE TRIGGER trg_supplier_part_price_history_updated_at
        AFTER UPDATE ON supplier_part_price_history
        FOR EACH ROW
        WHEN NEW.updated_at = OLD.updated_at
        BEGIN
          UPDATE supplier_part_price_history SET updated_at = (${SQL_NOW_MS}) WHERE id = NEW.id;
        END;
      `,
    },
  ],
};
