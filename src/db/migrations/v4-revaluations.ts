import { SQL_NOW_MS, type Migration } from './migration';

/**
 * v4 — Manual current value + revaluation log (feature-gap G9).
 *
 * Straight-line depreciation (`asset-lifecycle.ts`, v24 fields) only ever *lowers* an
 * asset's book value toward a salvage floor. Collectibles, tools and property appreciate,
 * and an insurance replacement schedule (G1) needs *today's* value, not a depreciated one.
 * This step adds an optional manual current / market value plus an append-only log of the
 * revaluations that set it — value can move up or down independently of the depreciation
 * curve.
 *
 * Two additive changes, mirroring the shipped supplier-cost + `supplier_part_price_history`
 * shape (a live column on the parent, an append-only history of the points that changed it):
 *
 *  - `items.current_value` — the live manual per-unit value (base currency), NULL when the
 *    item has none set. A partial CHECK keeps it non-negative, matching `purchase_price`.
 *  - `revaluations` — one row per recorded valuation point (`value`, `revalued_at`, optional
 *    `note`), FK → items ON DELETE CASCADE. A real synced LWW row (carries `updated_at` +
 *    the auto-stamp trigger); insert-only in practice, so a value's history is never
 *    overwritten and lost.
 *
 * Both are **purely additive**, so this appends cleanly as a forward migration and needs no
 * baseline re-squash (the v1 golden stays untouched); it ships as version 4. An existing
 * database at v1–v3 gains the column and table by running this step; a fresh install builds
 * them here on top of the v1 baseline.
 */
export const v4Revaluations: Migration = {
  version: 4,
  name: 'revaluations',
  statements: [
    {
      sql: `ALTER TABLE items ADD COLUMN current_value REAL CHECK (current_value IS NULL OR current_value >= 0);`,
    },
    {
      sql: `
        CREATE TABLE revaluations (
          id          TEXT    PRIMARY KEY NOT NULL,
          item_id     TEXT    NOT NULL REFERENCES items(id) ON DELETE CASCADE,
          value       REAL    NOT NULL,                    -- the recorded per-unit value at revalued_at
          revalued_at INTEGER NOT NULL DEFAULT (${SQL_NOW_MS}), -- effective date of the valuation (UNIX-ms)
          note        TEXT,
          created_at  INTEGER NOT NULL DEFAULT (${SQL_NOW_MS}),
          updated_at  INTEGER NOT NULL DEFAULT (${SQL_NOW_MS}),
          CHECK (value >= 0)
        ) STRICT;
      `,
    },
    {
      sql: `CREATE INDEX idx_revaluations_item_id ON revaluations(item_id, revalued_at);`,
    },
    {
      sql: `
        CREATE TRIGGER trg_revaluations_updated_at
        AFTER UPDATE ON revaluations
        FOR EACH ROW
        WHEN NEW.updated_at = OLD.updated_at
        BEGIN
          UPDATE revaluations SET updated_at = (${SQL_NOW_MS}) WHERE id = NEW.id;
        END;
      `,
    },
  ],
};
