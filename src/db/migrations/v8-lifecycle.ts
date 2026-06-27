import { CONDITIONS, MAINTENANCE_BASES } from '../repositories/constants';
import { SQL_NOW_MS, type Migration } from './migration';

/**
 * v8 — Procurement & Lifecycle Logistics (spec §4, §4.3, §4.4, Phase 9).
 *
 * Entirely additive DDL (column adds + one brand-new table; no table recreation,
 * so the §2.3.3 12-step pattern is not required):
 *
 *  - Perishables & Batch tracking (§4): nullable `expiry_date` (UNIX ms),
 *    `batch_number`, `lot_number` on `items`. A partial index over non-NULL
 *    expiry dates keeps the "Soon to Expire" query (§3 widget) tiny.
 *
 *  - Condition (§4 Condition Tracking / §4.3): nullable `condition` enum on `items`,
 *    CHECK-constrained to {@link CONDITIONS}. Soft-deletion states (Decommissioned/
 *    Broken/Consumed) stay modelled by `is_active = 0`; this enum is finer-grained
 *    operational state for high-value assets.
 *
 *  - Parent/Child variants (§4 Variant/SKU): a self-referential `parent_id`
 *    FK on `items`. The decision (Phase 9 scope) is an *abstract, single-level*
 *    parent — the parent holds only shared metadata while child variants carry
 *    qty/location. Adding a REFERENCES column via ALTER is legal because the column
 *    defaults to NULL (SQLite ADD COLUMN restriction). The "can't be its own
 *    ancestor / parents can't themselves be variants" rules are enforced in the
 *    repository layer with pure, unit-tested logic (mirroring the §7.5.3 cycle
 *    rejection used for locations), not as DB constraints.
 *
 *  - Tool Maintenance Schedules (§4.3): a new `maintenance_schedules` table. A
 *    schedule fires on elapsed `TIME` (days) or accrued `USAGE` (a manually-logged
 *    counter, since no automatic usage telemetry exists). Next-due is computed in
 *    the repository layer, never stored. It follows the §7.1 conventions (UUID PK,
 *    `updated_at` + auto-stamp trigger) and joins `SYNC_TABLES`.
 *
 * The Cycle Counting / Reconciliation workflow (§4.4) needs no schema: in-progress
 * counts live in ephemeral Tier-3 state; only the authorised Reconciliation
 * Adjustment persists, as an item quantity change plus a `RECONCILED` history row.
 */

/** Build the canonical auto-stamp trigger for a syncable table keyed by `id`. */
function updatedAtTrigger(table: string): string {
  return `
    CREATE TRIGGER trg_${table}_updated_at
    AFTER UPDATE ON ${table}
    FOR EACH ROW
    WHEN NEW.updated_at = OLD.updated_at
    BEGIN
      UPDATE ${table} SET updated_at = (${SQL_NOW_MS}) WHERE id = NEW.id;
    END;
  `;
}

const conditionList = CONDITIONS.map((c) => `'${c}'`).join(', ');
const basisList = MAINTENANCE_BASES.map((b) => `'${b}'`).join(', ');

export const v8Lifecycle: Migration = {
  version: 8,
  name: 'procurement-lifecycle',
  statements: [
    // --- Perishables & batch/lot tracking (§4) ---------------------------------
    { sql: `ALTER TABLE items ADD COLUMN expiry_date INTEGER;` },
    { sql: `ALTER TABLE items ADD COLUMN batch_number TEXT;` },
    { sql: `ALTER TABLE items ADD COLUMN lot_number TEXT;` },
    // Hot path: only perishables carry an expiry, so index only those rows.
    {
      sql: `CREATE INDEX idx_items_expiry ON items(expiry_date) WHERE expiry_date IS NOT NULL;`,
    },

    // --- Condition enum (§4 Condition Tracking, §4.3) --------------------------
    {
      sql: `ALTER TABLE items ADD COLUMN condition TEXT CHECK (condition IS NULL OR condition IN (${conditionList}));`,
    },

    // --- Parent/Child variants (§4 Variant/SKU) -------------------------------
    // Self-FK; NULL default makes the ADD COLUMN legal under FK enforcement.
    {
      sql: `ALTER TABLE items ADD COLUMN parent_id TEXT REFERENCES items(id);`,
    },
    { sql: `CREATE INDEX idx_items_parent_id ON items(parent_id);` },

    // --- Tool maintenance schedules (§4.3) ------------------------------------
    {
      sql: `
        CREATE TABLE maintenance_schedules (
          id                  TEXT    PRIMARY KEY NOT NULL,
          item_id             TEXT    NOT NULL REFERENCES items(id) ON DELETE CASCADE,
          name                TEXT    NOT NULL,
          basis               TEXT    NOT NULL,
          interval_days       INTEGER,
          interval_usage      REAL,
          usage_unit          TEXT,
          usage_since_service REAL    NOT NULL DEFAULT 0,
          last_performed_at   INTEGER,
          note                TEXT,
          created_at          INTEGER NOT NULL DEFAULT (${SQL_NOW_MS}),
          updated_at          INTEGER NOT NULL DEFAULT (${SQL_NOW_MS}),
          CHECK (basis IN (${basisList})),
          CHECK (usage_since_service >= 0),
          -- A TIME schedule needs a positive day interval; a USAGE schedule a
          -- positive usage interval. (DOM-drift-style: never a silent NULL.)
          CHECK (basis <> 'TIME'  OR (interval_days  IS NOT NULL AND interval_days  > 0)),
          CHECK (basis <> 'USAGE' OR (interval_usage IS NOT NULL AND interval_usage > 0))
        ) STRICT;
      `,
    },
    { sql: `CREATE INDEX idx_maintenance_schedules_item_id ON maintenance_schedules(item_id);` },
    { sql: updatedAtTrigger('maintenance_schedules') },
  ],
};
