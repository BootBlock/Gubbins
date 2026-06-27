import { FTS_ITEM_COLUMNS } from '../repositories/constants';
import { SQL_NOW_MS, type Migration } from './migration';

/**
 * v5 — Weighted Capabilities & FTS5 full-text search (spec §4, §5, §5.1, Phase 5).
 *
 * Adds, all as additive DDL (no table recreation, so the §2.3.3 12-step pattern is
 * not needed):
 *
 *  - `capabilities` — the §4 "Weighted Capabilities" store. One row per
 *    (item, key) parametric spec (e.g. `voltage` = 5, `package` = 'SMD'). A numeric
 *    magnitude (`value_num`) backs the AST's GREATER_THAN/LESS_THAN comparisons; a
 *    text value (`value_text`) backs EQUALS/HAS_CAPABILITY categorical matches; and
 *    a `weight` (default 1.0) expresses how salient that spec is, so search results
 *    can be ranked by aggregate matched weight rather than as flat boolean tags.
 *
 *  - `items_fts` — an **FTS5** external-content virtual table (spec §2.2.1a, §5)
 *    mirroring the lightweight text columns of `items` (name/description/mpn/
 *    manufacturer). External-content (`content='items'`) keeps the bytes in `items`
 *    and stores only the inverted index here. Three AFTER INSERT/UPDATE/DELETE sync
 *    triggers keep the index current (the canonical SQLite external-content
 *    pattern), and a `('rebuild')` command back-fills any rows that predate this
 *    migration. This replaces the Phase 2–4 `LIKE` scan in `ItemRepository.list`.
 *
 * FTS5 availability is verified at runtime at worker boot (`probeFts5`,
 * sqlite-bootstrap.ts) per the §2.2.1a compilation-trap warning — this migration
 * assumes that guard has already passed.
 *
 * The `capabilities` table replicates the §7.1 conventions: a `crypto.randomUUID()`
 * TEXT primary key, an `updated_at` UNIX-ms column, and an AFTER UPDATE auto-stamp
 * trigger carrying the `WHEN NEW.updated_at = OLD.updated_at` LWW pass-through guard.
 * (`items_fts` is a derived index, not a syncable table — it is rebuilt from `items`
 * on each device, never synchronised directly.)
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

/** The FTS5 indexed columns, in their fixed declaration order (e.g. `name, description, …`). */
const ftsColumns = FTS_ITEM_COLUMNS.join(', ');
/** The same columns prefixed with `new.` / `old.` for the sync-trigger payloads. */
const ftsNewValues = FTS_ITEM_COLUMNS.map((c) => `new.${c}`).join(', ');
const ftsOldValues = FTS_ITEM_COLUMNS.map((c) => `old.${c}`).join(', ');

export const v5CapabilitiesFts: Migration = {
  version: 5,
  name: 'capabilities-fts5-search',
  statements: [
    // --- weighted capabilities (§4) --------------------------------------------
    {
      sql: `
        CREATE TABLE capabilities (
          id         TEXT    PRIMARY KEY NOT NULL,
          item_id    TEXT    NOT NULL REFERENCES items(id) ON DELETE CASCADE,
          key        TEXT    NOT NULL,           -- e.g. 'voltage', 'package'
          value_num  REAL,                       -- numeric magnitude (>/< comparisons)
          value_text TEXT,                        -- text/categorical value (EQUALS/HAS)
          weight     REAL    NOT NULL DEFAULT 1.0, -- relevance/salience (§4 weighted)
          updated_at INTEGER NOT NULL DEFAULT (${SQL_NOW_MS}),
          CHECK (weight >= 0)
        ) STRICT;
      `,
    },
    { sql: `CREATE INDEX idx_capabilities_item_id ON capabilities(item_id);` },
    // Key lookups (HAS_CAPABILITY / capability:<key> filters) are case-insensitive.
    { sql: `CREATE INDEX idx_capabilities_key ON capabilities(key COLLATE NOCASE);` },
    // One value per (item, key): a part has a single 'voltage' spec, not many.
    {
      sql: `CREATE UNIQUE INDEX idx_capabilities_item_key ON capabilities(item_id, key COLLATE NOCASE);`,
    },
    { sql: updatedAtTrigger('capabilities') },

    // --- FTS5 full-text index over item text (§2.2.1a, §5) ----------------------
    {
      sql: `
        CREATE VIRTUAL TABLE items_fts USING fts5(
          ${ftsColumns},
          content='items',
          content_rowid='rowid'
        );
      `,
    },
    // External-content sync triggers (the canonical SQLite pattern): the FTS index
    // mirrors every items mutation. Deletes use the special 'delete' command row.
    {
      sql: `
        CREATE TRIGGER items_fts_ai AFTER INSERT ON items BEGIN
          INSERT INTO items_fts(rowid, ${ftsColumns}) VALUES (new.rowid, ${ftsNewValues});
        END;
      `,
    },
    {
      sql: `
        CREATE TRIGGER items_fts_ad AFTER DELETE ON items BEGIN
          INSERT INTO items_fts(items_fts, rowid, ${ftsColumns})
          VALUES ('delete', old.rowid, ${ftsOldValues});
        END;
      `,
    },
    {
      sql: `
        CREATE TRIGGER items_fts_au AFTER UPDATE ON items BEGIN
          INSERT INTO items_fts(items_fts, rowid, ${ftsColumns})
          VALUES ('delete', old.rowid, ${ftsOldValues});
          INSERT INTO items_fts(rowid, ${ftsColumns}) VALUES (new.rowid, ${ftsNewValues});
        END;
      `,
    },
    // Back-fill the index for any items created by earlier migrations/sessions.
    { sql: `INSERT INTO items_fts(items_fts) VALUES ('rebuild');` },
  ],
};
