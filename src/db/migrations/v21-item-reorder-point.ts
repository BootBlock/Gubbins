import type { Migration } from './migration';

/**
 * v21 — Per-item reorder points (Phase 59).
 *
 * Gubbins has carried only a single *global* low-stock threshold (the §3 dashboard
 * "Low Stock Alerts" feed defaults, user-tunable in Settings). Every direct competitor
 * (PartKeepr/InvenTree/Sortly) lets an individual part carry its **own** minimum, so a
 * box of common M3 screws and a rare specialist connector aren't held to the same line.
 * This closes that gap with the smallest possible additive change — three nullable
 * columns on `items`, each falling back to the existing global default when unset:
 *
 *  - `reorder_point` (INTEGER) — a DISCRETE item's own on-hand quantity floor. The item
 *    is "low" once `quantity` is at/below it. NULL = use the global qty threshold.
 *  - `reorder_gauge_percent` (REAL) — a CONSUMABLE_GAUGE item's own percentage-remaining
 *    floor. Low once the gauge is at/below it. NULL = use the global gauge percentage.
 *  - `reorder_qty` (INTEGER) — an optional suggested top-up amount (how many to buy when
 *    re-ordering), surfaced as a shopping-list hint. NULL = fall back to the shortfall to
 *    the reorder point.
 *
 * All three are NULL by default, so every pre-v21 item reads correctly with no backfill
 * and behaviour is *never* a regression — an item with no override is treated exactly as
 * before. They SHOULD sync (a part's reorder policy is shared inventory state, not a
 * device-local preference), so they are deliberately left out of `SYNC_EXCLUDED_COLUMNS`;
 * `items` is already in `SYNC_TABLES` and the LWW schema dictionary reads columns live via
 * `PRAGMA table_info`, so all three auto-join the sync payload with no further
 * registration. A nullable `ADD COLUMN` needs no §2.3.3 table recreation, and none is a
 * foreign key — so there is no `FK_REFS` entry and no `applyPlan`/delete null-out. The
 * `items` auto-stamp + FTS triggers are untouched.
 */
export const v21ItemReorderPoint: Migration = {
  version: 21,
  name: 'item-reorder-point',
  statements: [
    { sql: `ALTER TABLE items ADD COLUMN reorder_point INTEGER;` },
    { sql: `ALTER TABLE items ADD COLUMN reorder_gauge_percent REAL;` },
    { sql: `ALTER TABLE items ADD COLUMN reorder_qty INTEGER;` },
  ],
};
