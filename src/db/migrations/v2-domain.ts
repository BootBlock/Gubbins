import {
  TRACKING_MODES,
  UNASSIGNED_LOCATION_ID,
  UNASSIGNED_LOCATION_NAME,
} from '../repositories/constants';
import { SQL_NOW_MS, type Migration } from './migration';

/**
 * v2 — Core domain model (spec §4, §4.1, Phase 2).
 *
 * Introduces the inventory domain: `categories` (a minimal Phase 2 stub —
 * dynamic custom-field schemas are Phase 3), self-referential `locations`, the
 * `items` table (with the inline Consumable-Gauge primitive of §4.1.1), and the
 * immutable Activity Log `item_history` (§4 / §4.1.3).
 *
 * Every syncable table follows the §7.1 conventions established in v1: a
 * `crypto.randomUUID()` TEXT primary key, an `updated_at` UNIX-ms column defaulting
 * to {@link SQL_NOW_MS}, and an AFTER UPDATE auto-stamp trigger cloned from
 * `trg_app_meta_updated_at` (with the `WHEN NEW.updated_at = OLD.updated_at` guard
 * so the Phase 7 sync engine can apply a remote LWW timestamp). `item_history` is
 * an append-only ledger: it has no `updated_at` and an UPDATE guard enforces
 * immutability at the database level.
 *
 * The system-locked **"Unassigned"** location (§4) is seeded with a fixed sentinel
 * id and made immune to UPDATE/DELETE by dedicated guard triggers, defending the
 * §7.5.2 re-parent target even against a buggy repository.
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

const trackingModeList = TRACKING_MODES.map((mode) => `'${mode}'`).join(', ');

export const v2Domain: Migration = {
  version: 2,
  name: 'core-domain',
  statements: [
    // --- categories (Phase 2 stub) ---------------------------------------------
    {
      sql: `
        CREATE TABLE categories (
          id         TEXT    PRIMARY KEY NOT NULL,
          name       TEXT    NOT NULL,
          updated_at INTEGER NOT NULL DEFAULT (${SQL_NOW_MS})
        ) STRICT;
      `,
    },
    { sql: updatedAtTrigger('categories') },

    // --- locations (self-referential, infinitely nestable) ---------------------
    {
      sql: `
        CREATE TABLE locations (
          id         TEXT    PRIMARY KEY NOT NULL,
          name       TEXT    NOT NULL,
          parent_id  TEXT    REFERENCES locations(id),
          is_system  INTEGER NOT NULL DEFAULT 0,
          updated_at INTEGER NOT NULL DEFAULT (${SQL_NOW_MS}),
          CHECK (parent_id IS NULL OR parent_id <> id),
          CHECK (is_system IN (0, 1))
        ) STRICT;
      `,
    },
    { sql: `CREATE INDEX idx_locations_parent_id ON locations(parent_id);` },
    { sql: updatedAtTrigger('locations') },
    // The Unassigned location is system-locked: immune to modification and
    // deletion (spec §4). Guard at the DB level, beneath the repository.
    {
      sql: `
        CREATE TRIGGER trg_locations_protect_system_update
        BEFORE UPDATE ON locations
        FOR EACH ROW
        WHEN OLD.is_system = 1
        BEGIN
          SELECT RAISE(ABORT, 'The Unassigned location is system-locked and cannot be modified.');
        END;
      `,
    },
    {
      sql: `
        CREATE TRIGGER trg_locations_protect_system_delete
        BEFORE DELETE ON locations
        FOR EACH ROW
        WHEN OLD.is_system = 1
        BEGIN
          SELECT RAISE(ABORT, 'The Unassigned location is system-locked and cannot be deleted.');
        END;
      `,
    },
    // Seed the canonical Unassigned location with its fixed sentinel id.
    {
      sql: `
        INSERT INTO locations (id, name, parent_id, is_system)
        VALUES (?, ?, NULL, 1);
      `,
      params: [UNASSIGNED_LOCATION_ID, UNASSIGNED_LOCATION_NAME],
    },

    // --- items (with the inline Consumable-Gauge primitive, §4.1.1) ------------
    {
      sql: `
        CREATE TABLE items (
          id                   TEXT    PRIMARY KEY NOT NULL,
          name                 TEXT    NOT NULL,
          description          TEXT,
          location_id          TEXT    NOT NULL REFERENCES locations(id),
          category_id          TEXT    REFERENCES categories(id) ON DELETE SET NULL,
          tracking_mode        TEXT    NOT NULL DEFAULT 'DISCRETE',
          quantity             INTEGER NOT NULL DEFAULT 0,
          unit_of_measure      TEXT,
          gross_capacity       REAL,
          tare_weight          REAL,
          current_net_value    REAL,
          operational_metadata TEXT,
          is_active            INTEGER NOT NULL DEFAULT 1,
          created_at           INTEGER NOT NULL DEFAULT (${SQL_NOW_MS}),
          updated_at           INTEGER NOT NULL DEFAULT (${SQL_NOW_MS}),
          CHECK (tracking_mode IN (${trackingModeList})),
          CHECK (is_active IN (0, 1)),
          CHECK (quantity >= 0),
          CHECK (tracking_mode <> 'SERIALISED' OR quantity = 1),
          -- Gauge fields are mandatory and sane only for CONSUMABLE_GAUGE items.
          CHECK (
            tracking_mode <> 'CONSUMABLE_GAUGE' OR (
              unit_of_measure   IS NOT NULL AND
              gross_capacity    IS NOT NULL AND gross_capacity > 0 AND
              tare_weight       IS NOT NULL AND tare_weight >= 0 AND
              current_net_value IS NOT NULL AND current_net_value >= 0
            )
          )
        ) STRICT;
      `,
    },
    { sql: `CREATE INDEX idx_items_location_id ON items(location_id);` },
    { sql: `CREATE INDEX idx_items_category_id ON items(category_id);` },
    { sql: `CREATE INDEX idx_items_is_active ON items(is_active);` },
    { sql: updatedAtTrigger('items') },

    // --- item_history (immutable, append-only Activity Log, §4.1.3) ------------
    {
      sql: `
        CREATE TABLE item_history (
          id              TEXT    PRIMARY KEY NOT NULL,
          item_id         TEXT    NOT NULL REFERENCES items(id) ON DELETE CASCADE,
          action          TEXT    NOT NULL,
          quantity_delta  INTEGER,
          net_value_delta REAL,
          note            TEXT,
          metadata        TEXT,
          created_at      INTEGER NOT NULL DEFAULT (${SQL_NOW_MS})
        ) STRICT;
      `,
    },
    { sql: `CREATE INDEX idx_item_history_item_id ON item_history(item_id, created_at);` },
    // Append-only: the audit ledger must never be rewritten (spec §4 "immutable").
    {
      sql: `
        CREATE TRIGGER trg_item_history_immutable
        BEFORE UPDATE ON item_history
        FOR EACH ROW
        BEGIN
          SELECT RAISE(ABORT, 'item_history is an immutable, append-only ledger.');
        END;
      `,
    },
  ],
};
