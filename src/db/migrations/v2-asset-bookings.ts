import { SQL_NOW_MS, type Migration } from './migration';

/**
 * v2 — Time-based asset booking / reservations (Phase 78, third feature-gap audit
 * Wave 2 candidate #2). The **first** forward migration after the Phase-69 v1 squash.
 *
 * Adds the synced `asset_bookings` table: a calendar reservation of a **specific**
 * serialised / single-unit asset for a future whole-day date range ("book the 3D
 * printer Tue–Thu"), with double-booking prevented in the repository layer via a pure
 * date-range-overlap seam. This is deliberately **distinct** from the existing project
 * *quantity* reservation (`project_bom_lines.reserved_qty` / `reservation_status`), which
 * is a stock annotation — "N units are spoken for" — not a calendar hold on one
 * identifiable unit.
 *
 * ## Additive & forward — no local-DB wipe
 * Unlike the Phase-69 baseline squash (which *reset* `user_version` 24 → 1 and required a
 * dev wipe), this is an ordinary forward step: the engine applies only migrations whose
 * version is greater than the on-disk `user_version`, so an existing v1 database upgrades
 * to v2 by simply creating the new table — no existing table is touched and no data moves.
 *
 * ## Sync wiring (a booking is a real synced row, §7.1 LWW)
 * The table carries its own `updated_at` + the canonical auto-stamp trigger, so once it is
 * listed in `SYNC_TABLES` it resolves by the same row-level Last-Write-Wins as every other
 * entity table; its deletions are tombstoned (§7.2) and reconciled (§7.3). The `item_id`
 * (CASCADE) and `contact_id` (SET NULL) foreign keys get their `FK_REFS` guards in the
 * reconcile engine. `converted_checkout_id` is a nullable plain-text soft pointer (NOT a
 * foreign key, mirroring the Phase-29 `source_batch_key` decision): a dangling pointer
 * after a checkout is deleted is harmless — it only drives the derived "Checked out" label.
 *
 * The calendar lifecycle states (upcoming / active / overdue / converted / cancelled) are
 * **derived** from the dates plus the two nullable columns `cancelled_at` and
 * `converted_checkout_id` — never a stored enum — mirroring how a checkout derives
 * OPEN/RETURNED from its nullable `returned_at` and keeping LWW a simple one-column write.
 */
export const v2AssetBookings: Migration = {
  version: 2,
  name: 'asset-bookings',
  statements: [
    {
      sql: `
        CREATE TABLE asset_bookings (
          id                    TEXT    PRIMARY KEY NOT NULL,
          item_id               TEXT    NOT NULL REFERENCES items(id) ON DELETE CASCADE,
          contact_id            TEXT    REFERENCES contacts(id) ON DELETE SET NULL,
          start_date            INTEGER NOT NULL,            -- day-start UNIX-ms (inclusive)
          end_date              INTEGER NOT NULL,            -- day-start UNIX-ms (inclusive)
          note                  TEXT,
          cancelled_at          INTEGER,                     -- set ⇒ derived 'cancelled'
          converted_checkout_id TEXT,                        -- set ⇒ derived 'converted' (soft pointer, not FK)
          created_at            INTEGER NOT NULL DEFAULT (${SQL_NOW_MS}),
          updated_at            INTEGER NOT NULL DEFAULT (${SQL_NOW_MS}),
          CHECK (end_date >= start_date)
        ) STRICT;
      `,
    },
    {
      sql: `CREATE INDEX idx_asset_bookings_item_id ON asset_bookings(item_id, start_date);`,
    },
    {
      sql: `CREATE INDEX idx_asset_bookings_start_date ON asset_bookings(start_date);`,
    },
    {
      sql: `
        CREATE TRIGGER trg_asset_bookings_updated_at
        AFTER UPDATE ON asset_bookings
        FOR EACH ROW
        WHEN NEW.updated_at = OLD.updated_at
        BEGIN
          UPDATE asset_bookings SET updated_at = (${SQL_NOW_MS}) WHERE id = NEW.id;
        END;
      `,
    },
  ],
};
