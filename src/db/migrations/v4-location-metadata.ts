import type { Migration } from './migration';

/**
 * v4 — Richer location metadata (Add-location dialog enrichment). The third forward
 * migration after the Phase-69 v1 squash, following v2 `asset_bookings` and v3
 * `supplier_part_price_history`.
 *
 * Adds four columns to `locations`:
 *  - `kind` — a semantic type key (Cabinet, Shelf, Drawer, Vehicle…) that drives the
 *    per-location icon shown in the tree and pickers (null ⇒ generic folder).
 *  - `capacity` — an optional item-capacity limit powering a fullness gauge and a soft
 *    "location is full" warning when adding/moving items (null ⇒ unbounded).
 *  - `is_default` — marks the single location pre-selected when adding new items.
 *  - `archived_at` — a soft-archive timestamp (null ⇒ active) that hides a location from
 *    the tree and pickers without deleting it or its history.
 *
 * ## Additive & forward — no local-DB wipe
 * An ordinary forward step: the engine applies only migrations whose version exceeds the
 * on-disk `user_version`, so a v3 database upgrades to v4 by adding these columns — no
 * existing column is touched and no data moves. (This deliberately replaces the earlier
 * attempt to fold the columns into the v1 baseline, which would only have reached a
 * freshly-wiped database and left existing v3 dev databases missing the columns.)
 *
 * ## Sync wiring
 * These are new columns on an already-synced table, not a new table. The §7 snapshot reads
 * rows with `SELECT *` and upserts only columns the local schema has, so the new values ride
 * along under the same row-level Last-Write-Wins with no reconcile changes. (`is_default` is
 * a per-row flag, so two peers each choosing a different default converge to whichever row
 * wins LWW — a cosmetic pre-selection only, never data loss.)
 */
export const v4LocationMetadata: Migration = {
  version: 4,
  name: 'location-metadata',
  statements: [
    { sql: `ALTER TABLE locations ADD COLUMN kind TEXT;` },
    {
      sql: `ALTER TABLE locations ADD COLUMN capacity INTEGER CHECK (capacity IS NULL OR capacity >= 0);`,
    },
    {
      sql: `ALTER TABLE locations ADD COLUMN is_default INTEGER NOT NULL DEFAULT 0 CHECK (is_default IN (0, 1));`,
    },
    { sql: `ALTER TABLE locations ADD COLUMN archived_at INTEGER;` },
  ],
};
