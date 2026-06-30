import type { Migration } from './migration';

/**
 * v24 — Per-item asset lifecycle facet (Phase 66).
 *
 * Snipe-IT and similar asset-register tools let each item carry basic acquisition
 * and valuation data — when it was bought, when the warranty runs out, what it cost
 * and how fast it loses value. Gubbins gains parity with the smallest possible
 * additive change: four nullable columns on `items`, all NULL by default so every
 * pre-v24 item reads correctly with no backfill and behaviour is *never* a
 * regression.
 *
 *  - `acquired_at`          TEXT (ISO date, nullable) — the date the item was acquired
 *    (purchase date / manufacture date). Stored as an ISO 8601 calendar date string
 *    (`YYYY-MM-DD`) to match the `<input type="date">` wire format and avoid the
 *    timezone ambiguity of a UNIX-ms instant for an all-day event.
 *
 *  - `warranty_expires_at`  TEXT (ISO date, nullable) — when the manufacturer/supplier
 *    warranty expires. Stored in the same ISO date format. The `warrantyStatus` pure
 *    function (`asset-lifecycle.ts`) derives `active` / `expiring-soon` / `expired`
 *    from this field and the current wall-clock date.
 *
 *  - `purchase_price`       REAL nullable, CHECK ≥ 0 — the original acquisition cost in
 *    the base currency. Paired with `depreciation_months` to derive the current book
 *    value via straight-line depreciation (`currentValue` in `asset-lifecycle.ts`).
 *
 *  - `depreciation_months`  INTEGER nullable, CHECK > 0 — the useful life of the asset
 *    in months for straight-line calculation. NULL means "no depreciation" — the book
 *    value stays equal to `purchase_price`.
 *
 * All four SHOULD sync (asset records are shared inventory state, not device-local
 * preferences), so they are deliberately *not* in `SYNC_EXCLUDED_COLUMNS`. `items` is
 * already in `SYNC_TABLES` and the LWW schema dictionary reads columns live via
 * `PRAGMA table_info`, so all four auto-join the sync payload with no further
 * registration. A nullable `ADD COLUMN` needs no §2.3.3 table recreation, and none is
 * a foreign key — so there is no `FK_REFS` entry and no `applyPlan`/delete null-out.
 * The `items` auto-stamp + FTS triggers are untouched.
 */
export const v24ItemAssetLifecycle: Migration = {
  version: 24,
  name: 'item-asset-lifecycle',
  statements: [
    { sql: `ALTER TABLE items ADD COLUMN acquired_at TEXT;` },
    { sql: `ALTER TABLE items ADD COLUMN warranty_expires_at TEXT;` },
    {
      sql: `ALTER TABLE items ADD COLUMN purchase_price REAL CHECK (purchase_price IS NULL OR purchase_price >= 0);`,
    },
    {
      sql: `ALTER TABLE items ADD COLUMN depreciation_months INTEGER CHECK (depreciation_months IS NULL OR depreciation_months > 0);`,
    },
  ],
};
