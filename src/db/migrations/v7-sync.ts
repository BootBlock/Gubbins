import { SQL_NOW_MS, type Migration } from './migration';

/**
 * v7 — Cloud-sync bookkeeping: tombstones & sync metadata (spec §7.2, §7.3, Phase 7).
 *
 * Wholly additive DDL (two brand-new tables, no recreation, so the §2.3.3 12-step
 * pattern is not needed):
 *
 *  - `tombstones` — the §7.2 Tombstone Pattern. A hard delete removes the row from
 *    its table but records `(table_name, id, deleted_at)` here so the deletion can
 *    be *propagated* during synchronisation rather than mis-read as "a row the peer
 *    is missing and should download". Keyed by `(table_name, id)` so re-deleting a
 *    re-created id simply refreshes `deleted_at` (INSERT OR REPLACE), and so the
 *    §7.2 180-day TTL prune is a single `deleted_at < cutoff` sweep.
 *
 *  - `sync_meta` — a single pinned row (`id = 1`) holding the `last_sync_timestamp`
 *    (drives the §7.2 TTL "full-wipe vs delta" decision and the Pre-Wipe Salvage
 *    cut-off) and the most recent `clock_offset` (§7.3 NTP offset guard, derived
 *    from the provider's response `Date` header). Pure bookkeeping — never synced.
 *
 * `tombstones` carries `deleted_at` (its LWW timestamp) but no `updated_at` trigger:
 * a tombstone is immutable once written (a re-delete replaces it wholesale), so it
 * needs no auto-stamp. `sync_meta` is local-only and likewise untriggered.
 */
export const v7Sync: Migration = {
  version: 7,
  name: 'sync-tombstones-meta',
  statements: [
    // --- tombstones (§7.2 Handling Deletions) ----------------------------------
    {
      sql: `
        CREATE TABLE tombstones (
          table_name TEXT    NOT NULL,
          id         TEXT    NOT NULL,
          deleted_at INTEGER NOT NULL DEFAULT (${SQL_NOW_MS}),
          PRIMARY KEY (table_name, id)
        ) STRICT;
      `,
    },
    // The TTL prune (§7.2) and the "rows deleted since last sync" query both scan by time.
    { sql: `CREATE INDEX idx_tombstones_deleted_at ON tombstones(deleted_at);` },

    // --- sync metadata (§7.3 lifecycle bookkeeping) ----------------------------
    {
      sql: `
        CREATE TABLE sync_meta (
          id                  INTEGER PRIMARY KEY NOT NULL CHECK (id = 1),
          last_sync_timestamp INTEGER NOT NULL DEFAULT 0,
          clock_offset        INTEGER NOT NULL DEFAULT 0,
          updated_at          INTEGER NOT NULL DEFAULT (${SQL_NOW_MS})
        ) STRICT;
      `,
    },
    // Seed the single pinned row so callers can always UPDATE rather than UPSERT.
    { sql: `INSERT INTO sync_meta (id, last_sync_timestamp, clock_offset) VALUES (1, 0, 0);` },
  ],
};
