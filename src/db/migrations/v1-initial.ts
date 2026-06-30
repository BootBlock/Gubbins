import {
  ATTACHMENT_KINDS,
  CONDITIONS,
  COSTING_MODES,
  FIELD_TYPES,
  IN_TRANSIT_LOCATION_ID,
  IN_TRANSIT_LOCATION_NAME,
  MAINTENANCE_BASES,
  PROCUREMENT_STATUSES,
  PROJECT_STATUSES,
  RESERVATION_STATUSES,
  TRACKING_MODES,
  UNASSIGNED_LOCATION_ID,
  UNASSIGNED_LOCATION_NAME,
} from '../repositories/constants';
import { SQL_NOW_MS, type Migration } from './migration';

/**
 * v1 — Consolidated baseline schema (Phase 69 migration-baseline squash).
 *
 * This single migration builds the **entire current schema** in one step. It is the
 * squash of the original v1…v24 migration chain: Gubbins is pre-release with
 * disposable developer-only data, so no incremental upgrade path from an older
 * on-disk version is required (§ migration-baseline consolidation). The migration
 * *engine* (`runMigrations`/`getUserVersion`/the strict-contiguity guard) and all
 * its sync wiring (`SYNC_TABLES`, `FK_REFS`) are unchanged — only the historical
 * step files are collapsed into this baseline.
 *
 * ## Zero schema drift — a hard contract
 * The statement stream below is the **exact, ordered concatenation** of the original
 * v1…v24 `statements` (minus the per-step `PRAGMA user_version` bumps, which the
 * engine still appends — once, for v1). It is therefore byte-for-byte identical to
 * the schema the historical chain produced: the same CREATEs, the same ALTERs folded
 * in their original positions (SQLite stores an ALTER-added column verbatim at the
 * tail of the table's stored `sql`, so re-issuing the original ALTER is the only way
 * to reproduce that stored text exactly), the same indexes, the §7.1 `updated_at`
 * auto-stamp triggers, the v5 FTS5 external-content index + sync triggers, and the
 * v13 `item_stock` / v15 `stock_batches` projection-recompute triggers. The
 * `v1-initial.test.ts` golden-equivalence test proves this byte-identity against the
 * committed `__fixtures__/schema-baseline.snapshot.json` (the dump of the original
 * chain), so the squash provably changed nothing.
 *
 * The original per-phase grouping is preserved as authored: tables come before the
 * children that reference them, triggers after their tables, the FTS index after its
 * `items` content table, and the recompute triggers after their ledgers — the
 * dependency order the chain already ran in. The `SQL_NOW_MS` epoch expression, the
 * `updatedAtTrigger()` helper, and the CHECK-list constants (`FIELD_TYPES`,
 * `ATTACHMENT_KINDS`, …) are reused exactly as the originals did, so the enum CHECKs
 * stay in lock-step with the application constants.
 *
 * Trigger semantics (unchanged from the original v1): on UPDATE the auto-stamp
 * trigger stamps `updated_at` to "now" **only when the caller left it unchanged**.
 * An UPDATE that sets `updated_at` explicitly (as the §7.3 sync engine does, applying
 * a remote Last-Write-Wins value) is passed through untouched — exactly the behaviour
 * LWW reconciliation needs.
 */

/** Build the canonical auto-stamp trigger for a syncable table keyed by `id` (§7.1). */
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

// Enum CHECK lists, derived from the shared application constants so a constant edit
// can never drift from the schema's CHECK constraint.
const trackingModeList = TRACKING_MODES.map((mode) => `'${mode}'`).join(', ');
const fieldTypeList = FIELD_TYPES.map((t) => `'${t}'`).join(', ');
const attachmentKindList = ATTACHMENT_KINDS.map((k) => `'${k}'`).join(', ');
const projectStatusList = PROJECT_STATUSES.map((s) => `'${s}'`).join(', ');
const costingModeList = COSTING_MODES.map((m) => `'${m}'`).join(', ');
const reservationStatusList = RESERVATION_STATUSES.map((s) => `'${s}'`).join(', ');
const procurementStatusList = PROCUREMENT_STATUSES.map((s) => `'${s}'`).join(', ');
const conditionList = CONDITIONS.map((c) => `'${c}'`).join(', ');
const basisList = MAINTENANCE_BASES.map((b) => `'${b}'`).join(', ');

export const v1Initial: Migration = {
  version: 1,
  name: 'initial-baseline',
  statements: [
    {
      sql: `
        CREATE TABLE app_meta (
          key        TEXT    PRIMARY KEY NOT NULL,
          value      TEXT,
          updated_at INTEGER NOT NULL DEFAULT (${SQL_NOW_MS})
        ) STRICT;
      `,
    },
    {
      sql: `
        CREATE TRIGGER trg_app_meta_updated_at
        AFTER UPDATE ON app_meta
        FOR EACH ROW
        WHEN NEW.updated_at = OLD.updated_at
        BEGIN
          UPDATE app_meta SET updated_at = (${SQL_NOW_MS}) WHERE key = NEW.key;
        END;
      `,
    },
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
    {
      sql: `
        INSERT INTO locations (id, name, parent_id, is_system)
        VALUES (?, ?, NULL, 1);
      `,
      params: [UNASSIGNED_LOCATION_ID, UNASSIGNED_LOCATION_NAME],
    },
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
    {
      sql: `CREATE INDEX idx_item_history_item_id ON item_history(item_id, created_at);`,
    },
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
    { sql: `ALTER TABLE items ADD COLUMN serial_no INTEGER;` },
    {
      sql: `
        CREATE TABLE category_fields (
          id            TEXT    PRIMARY KEY NOT NULL,
          category_id   TEXT    NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
          name          TEXT    NOT NULL,
          field_type    TEXT    NOT NULL,
          options       TEXT,                          -- JSON array for SELECT fields
          is_required   INTEGER NOT NULL DEFAULT 0,
          default_value TEXT,                          -- lenient-defaulting value (§4)
          position      INTEGER NOT NULL DEFAULT 0,
          updated_at    INTEGER NOT NULL DEFAULT (${SQL_NOW_MS}),
          CHECK (field_type IN (${fieldTypeList})),
          CHECK (is_required IN (0, 1))
        ) STRICT;
      `,
    },
    {
      sql: `CREATE INDEX idx_category_fields_category_id ON category_fields(category_id);`,
    },
    { sql: updatedAtTrigger('category_fields') },
    {
      sql: `
        CREATE TABLE item_field_values (
          id         TEXT    PRIMARY KEY NOT NULL,
          item_id    TEXT    NOT NULL REFERENCES items(id) ON DELETE CASCADE,
          field_id   TEXT    NOT NULL REFERENCES category_fields(id) ON DELETE CASCADE,
          value      TEXT,
          updated_at INTEGER NOT NULL DEFAULT (${SQL_NOW_MS}),
          UNIQUE (item_id, field_id)
        ) STRICT;
      `,
    },
    {
      sql: `CREATE INDEX idx_item_field_values_item_id ON item_field_values(item_id);`,
    },
    {
      sql: `CREATE INDEX idx_item_field_values_field_id ON item_field_values(field_id);`,
    },
    { sql: updatedAtTrigger('item_field_values') },
    {
      sql: `
        CREATE TABLE tags (
          id         TEXT    PRIMARY KEY NOT NULL,
          name       TEXT    NOT NULL,
          updated_at INTEGER NOT NULL DEFAULT (${SQL_NOW_MS})
        ) STRICT;
      `,
    },
    { sql: `CREATE UNIQUE INDEX idx_tags_name ON tags(name COLLATE NOCASE);` },
    { sql: updatedAtTrigger('tags') },
    {
      sql: `
        CREATE TABLE item_tags (
          item_id TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
          tag_id  TEXT NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
          PRIMARY KEY (item_id, tag_id)
        ) STRICT;
      `,
    },
    { sql: `CREATE INDEX idx_item_tags_tag_id ON item_tags(tag_id);` },
    {
      sql: `
        CREATE TABLE item_images (
          id                 TEXT    PRIMARY KEY NOT NULL,
          item_id            TEXT    NOT NULL REFERENCES items(id) ON DELETE CASCADE,
          thumbnail_blob     BLOB,
          full_res_opfs_path TEXT    NOT NULL,
          position           INTEGER NOT NULL DEFAULT 0,
          created_at         INTEGER NOT NULL DEFAULT (${SQL_NOW_MS}),
          updated_at         INTEGER NOT NULL DEFAULT (${SQL_NOW_MS})
        ) STRICT;
      `,
    },
    {
      sql: `CREATE INDEX idx_item_images_item_id ON item_images(item_id, position);`,
    },
    { sql: updatedAtTrigger('item_images') },
    {
      sql: `
        CREATE TABLE item_attachments (
          id         TEXT    PRIMARY KEY NOT NULL,
          item_id    TEXT    NOT NULL REFERENCES items(id) ON DELETE CASCADE,
          kind       TEXT    NOT NULL,
          value      TEXT    NOT NULL,
          label      TEXT,
          position   INTEGER NOT NULL DEFAULT 0,
          created_at INTEGER NOT NULL DEFAULT (${SQL_NOW_MS}),
          updated_at INTEGER NOT NULL DEFAULT (${SQL_NOW_MS}),
          CHECK (kind IN (${attachmentKindList}))
        ) STRICT;
      `,
    },
    {
      sql: `CREATE INDEX idx_item_attachments_item_id ON item_attachments(item_id, position);`,
    },
    { sql: updatedAtTrigger('item_attachments') },
    { sql: `ALTER TABLE items ADD COLUMN mpn TEXT;` },
    { sql: `ALTER TABLE items ADD COLUMN manufacturer TEXT;` },
    { sql: `ALTER TABLE items ADD COLUMN unit_cost REAL;` },
    { sql: `CREATE INDEX idx_items_mpn ON items(mpn COLLATE NOCASE);` },
    {
      sql: `
        CREATE TABLE item_aliases (
          id         TEXT    PRIMARY KEY NOT NULL,
          item_id    TEXT    NOT NULL REFERENCES items(id) ON DELETE CASCADE,
          alias      TEXT    NOT NULL,
          updated_at INTEGER NOT NULL DEFAULT (${SQL_NOW_MS})
        ) STRICT;
      `,
    },
    {
      sql: `CREATE UNIQUE INDEX idx_item_aliases_alias ON item_aliases(alias COLLATE NOCASE);`,
    },
    { sql: `CREATE INDEX idx_item_aliases_item_id ON item_aliases(item_id);` },
    { sql: updatedAtTrigger('item_aliases') },
    {
      sql: `
        INSERT INTO locations (id, name, parent_id, is_system)
        VALUES (?, ?, NULL, 1);
      `,
      params: [IN_TRANSIT_LOCATION_ID, IN_TRANSIT_LOCATION_NAME],
    },
    {
      sql: `
        CREATE TABLE projects (
          id           TEXT    PRIMARY KEY NOT NULL,
          name         TEXT    NOT NULL,
          description  TEXT,
          status       TEXT    NOT NULL DEFAULT 'PLANNING',
          costing_mode TEXT    NOT NULL DEFAULT 'CURRENT_REPLACEMENT',
          created_at   INTEGER NOT NULL DEFAULT (${SQL_NOW_MS}),
          updated_at   INTEGER NOT NULL DEFAULT (${SQL_NOW_MS}),
          CHECK (status IN (${projectStatusList})),
          CHECK (costing_mode IN (${costingModeList}))
        ) STRICT;
      `,
    },
    { sql: updatedAtTrigger('projects') },
    {
      sql: `
        CREATE TABLE project_bom_lines (
          id                 TEXT    PRIMARY KEY NOT NULL,
          project_id         TEXT    NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
          item_id            TEXT    REFERENCES items(id) ON DELETE SET NULL,
          designator         TEXT,
          mpn                TEXT,
          manufacturer       TEXT,
          description        TEXT,
          required_qty       INTEGER NOT NULL DEFAULT 1,
          reserved_qty       INTEGER NOT NULL DEFAULT 0,
          reservation_status TEXT    NOT NULL DEFAULT 'NONE',
          procurement_status TEXT    NOT NULL DEFAULT 'NONE',
          unit_cost_snapshot REAL,
          position           INTEGER NOT NULL DEFAULT 0,
          created_at         INTEGER NOT NULL DEFAULT (${SQL_NOW_MS}),
          updated_at         INTEGER NOT NULL DEFAULT (${SQL_NOW_MS}),
          CHECK (required_qty >= 0),
          CHECK (reserved_qty >= 0),
          CHECK (reservation_status IN (${reservationStatusList})),
          CHECK (procurement_status IN (${procurementStatusList}))
        ) STRICT;
      `,
    },
    {
      sql: `CREATE INDEX idx_project_bom_lines_project_id ON project_bom_lines(project_id, position);`,
    },
    {
      sql: `CREATE INDEX idx_project_bom_lines_item_id ON project_bom_lines(item_id);`,
    },
    { sql: updatedAtTrigger('project_bom_lines') },
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
    {
      sql: `CREATE INDEX idx_capabilities_key ON capabilities(key COLLATE NOCASE);`,
    },
    {
      sql: `CREATE UNIQUE INDEX idx_capabilities_item_key ON capabilities(item_id, key COLLATE NOCASE);`,
    },
    { sql: updatedAtTrigger('capabilities') },
    {
      sql: `
        CREATE VIRTUAL TABLE items_fts USING fts5(
          name, description, mpn, manufacturer,
          content='items',
          content_rowid='rowid'
        );
      `,
    },
    {
      sql: `
        CREATE TRIGGER items_fts_ai AFTER INSERT ON items BEGIN
          INSERT INTO items_fts(rowid, name, description, mpn, manufacturer) VALUES (new.rowid, new.name, new.description, new.mpn, new.manufacturer);
        END;
      `,
    },
    {
      sql: `
        CREATE TRIGGER items_fts_ad AFTER DELETE ON items BEGIN
          INSERT INTO items_fts(items_fts, rowid, name, description, mpn, manufacturer)
          VALUES ('delete', old.rowid, old.name, old.description, old.mpn, old.manufacturer);
        END;
      `,
    },
    {
      sql: `
        CREATE TRIGGER items_fts_au AFTER UPDATE ON items BEGIN
          INSERT INTO items_fts(items_fts, rowid, name, description, mpn, manufacturer)
          VALUES ('delete', old.rowid, old.name, old.description, old.mpn, old.manufacturer);
          INSERT INTO items_fts(rowid, name, description, mpn, manufacturer) VALUES (new.rowid, new.name, new.description, new.mpn, new.manufacturer);
        END;
      `,
    },
    { sql: `INSERT INTO items_fts(items_fts) VALUES ('rebuild');` },
    {
      sql: `
        CREATE TABLE contacts (
          id         TEXT    PRIMARY KEY NOT NULL,
          name       TEXT    NOT NULL,
          note       TEXT,
          created_at INTEGER NOT NULL DEFAULT (${SQL_NOW_MS}),
          updated_at INTEGER NOT NULL DEFAULT (${SQL_NOW_MS})
        ) STRICT;
      `,
    },
    {
      sql: `CREATE UNIQUE INDEX idx_contacts_name ON contacts(name COLLATE NOCASE);`,
    },
    { sql: updatedAtTrigger('contacts') },
    {
      sql: `
        CREATE TABLE checkouts (
          id             TEXT    PRIMARY KEY NOT NULL,
          item_id        TEXT    NOT NULL REFERENCES items(id) ON DELETE CASCADE,
          contact_id     TEXT    NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
          quantity       INTEGER NOT NULL DEFAULT 1,
          due_date       INTEGER,
          checked_out_at INTEGER NOT NULL DEFAULT (${SQL_NOW_MS}),
          returned_at    INTEGER,
          note           TEXT,
          updated_at     INTEGER NOT NULL DEFAULT (${SQL_NOW_MS}),
          CHECK (quantity > 0),
          CHECK (returned_at IS NULL OR returned_at >= checked_out_at)
        ) STRICT;
      `,
    },
    { sql: `CREATE INDEX idx_checkouts_item_id ON checkouts(item_id);` },
    { sql: `CREATE INDEX idx_checkouts_contact_id ON checkouts(contact_id);` },
    {
      sql: `CREATE INDEX idx_checkouts_open ON checkouts(due_date) WHERE returned_at IS NULL;`,
    },
    { sql: updatedAtTrigger('checkouts') },
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
    {
      sql: `CREATE INDEX idx_tombstones_deleted_at ON tombstones(deleted_at);`,
    },
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
    {
      sql: `INSERT INTO sync_meta (id, last_sync_timestamp, clock_offset) VALUES (1, 0, 0);`,
    },
    { sql: `ALTER TABLE items ADD COLUMN expiry_date INTEGER;` },
    { sql: `ALTER TABLE items ADD COLUMN batch_number TEXT;` },
    { sql: `ALTER TABLE items ADD COLUMN lot_number TEXT;` },
    {
      sql: `CREATE INDEX idx_items_expiry ON items(expiry_date) WHERE expiry_date IS NOT NULL;`,
    },
    {
      sql: `ALTER TABLE items ADD COLUMN condition TEXT CHECK (condition IS NULL OR condition IN (${conditionList}));`,
    },
    {
      sql: `ALTER TABLE items ADD COLUMN parent_id TEXT REFERENCES items(id);`,
    },
    { sql: `CREATE INDEX idx_items_parent_id ON items(parent_id);` },
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
    {
      sql: `CREATE INDEX idx_maintenance_schedules_item_id ON maintenance_schedules(item_id);`,
    },
    { sql: updatedAtTrigger('maintenance_schedules') },
    {
      sql: `ALTER TABLE item_images ADD COLUMN full_res_downgraded_at INTEGER;`,
    },
    {
      sql: `ALTER TABLE sync_meta ADD COLUMN history_pruned_before INTEGER NOT NULL DEFAULT 0;`,
    },
    {
      sql: `ALTER TABLE maintenance_schedules ADD COLUMN accrue_checkout_hours INTEGER NOT NULL DEFAULT 0;`,
    },
    {
      sql: `ALTER TABLE project_bom_lines ADD COLUMN received_qty INTEGER NOT NULL DEFAULT 0;`,
    },
    {
      sql: `
        CREATE TABLE item_stock (
          id          TEXT    PRIMARY KEY NOT NULL,
          item_id     TEXT    NOT NULL REFERENCES items(id) ON DELETE CASCADE,
          location_id TEXT    NOT NULL REFERENCES locations(id),
          quantity    INTEGER NOT NULL DEFAULT 0,
          created_at  INTEGER NOT NULL DEFAULT (${SQL_NOW_MS}),
          updated_at  INTEGER NOT NULL DEFAULT (${SQL_NOW_MS}),
          CHECK (quantity >= 0),
          UNIQUE (item_id, location_id)
        ) STRICT;
      `,
    },
    { sql: `CREATE INDEX idx_item_stock_item_id ON item_stock(item_id);` },
    {
      sql: `CREATE INDEX idx_item_stock_location_id ON item_stock(location_id);`,
    },
    {
      sql: `
        CREATE TRIGGER trg_item_stock_updated_at
        AFTER UPDATE ON item_stock
        FOR EACH ROW
        WHEN NEW.updated_at = OLD.updated_at
        BEGIN
          UPDATE item_stock SET updated_at = (${SQL_NOW_MS}) WHERE id = NEW.id;
        END;
      `,
    },
    {
      sql: `
        INSERT INTO item_stock (id, item_id, location_id, quantity, created_at, updated_at)
        SELECT id || '|' || location_id, id, location_id, quantity, created_at, updated_at
        FROM items;
      `,
    },
    {
      sql: `
        CREATE TRIGGER trg_item_stock_recompute_ins
        AFTER INSERT ON item_stock
        FOR EACH ROW
        BEGIN
          UPDATE items
          SET quantity = (SELECT COALESCE(SUM(quantity), 0) FROM item_stock WHERE item_id = NEW.item_id)
          WHERE id = NEW.item_id
            AND quantity <> (SELECT COALESCE(SUM(quantity), 0) FROM item_stock WHERE item_id = NEW.item_id);
        END;
      `,
    },
    {
      sql: `
        CREATE TRIGGER trg_item_stock_recompute_upd
        AFTER UPDATE ON item_stock
        FOR EACH ROW
        BEGIN
          UPDATE items
          SET quantity = (SELECT COALESCE(SUM(quantity), 0) FROM item_stock WHERE item_id = NEW.item_id)
          WHERE id = NEW.item_id
            AND quantity <> (SELECT COALESCE(SUM(quantity), 0) FROM item_stock WHERE item_id = NEW.item_id);
        END;
      `,
    },
    {
      sql: `
        CREATE TRIGGER trg_item_stock_recompute_del
        AFTER DELETE ON item_stock
        FOR EACH ROW
        BEGIN
          UPDATE items
          SET quantity = (SELECT COALESCE(SUM(quantity), 0) FROM item_stock WHERE item_id = OLD.item_id)
          WHERE id = OLD.item_id
            AND quantity <> (SELECT COALESCE(SUM(quantity), 0) FROM item_stock WHERE item_id = OLD.item_id);
        END;
      `,
    },
    {
      sql: `ALTER TABLE checkouts ADD COLUMN source_location_id TEXT REFERENCES locations(id);`,
    },
    {
      sql: `
        CREATE TABLE stock_batches (
          id           TEXT    PRIMARY KEY NOT NULL,
          item_id      TEXT    NOT NULL REFERENCES items(id) ON DELETE CASCADE,
          location_id  TEXT    NOT NULL REFERENCES locations(id),
          batch_key    TEXT    NOT NULL,
          batch_number TEXT,
          lot_number   TEXT,
          expiry_date  INTEGER,
          quantity     INTEGER NOT NULL DEFAULT 0,
          created_at   INTEGER NOT NULL DEFAULT (${SQL_NOW_MS}),
          updated_at   INTEGER NOT NULL DEFAULT (${SQL_NOW_MS}),
          CHECK (quantity >= 0),
          UNIQUE (item_id, location_id, batch_key)
        ) STRICT;
      `,
    },
    {
      sql: `CREATE INDEX idx_stock_batches_item_id ON stock_batches(item_id);`,
    },
    {
      sql: `CREATE INDEX idx_stock_batches_location_id ON stock_batches(location_id);`,
    },
    {
      sql: `CREATE INDEX idx_stock_batches_placement ON stock_batches(item_id, location_id);`,
    },
    {
      sql: `CREATE INDEX idx_stock_batches_expiry ON stock_batches(expiry_date);`,
    },
    {
      sql: `
        CREATE TRIGGER trg_stock_batches_updated_at
        AFTER UPDATE ON stock_batches
        FOR EACH ROW
        WHEN NEW.updated_at = OLD.updated_at
        BEGIN
          UPDATE stock_batches SET updated_at = (${SQL_NOW_MS}) WHERE id = NEW.id;
        END;
      `,
    },
    {
      sql: `
        INSERT INTO stock_batches (id, item_id, location_id, batch_key, quantity, created_at, updated_at)
        SELECT id || '|', item_id, location_id, '', quantity, created_at, updated_at
        FROM item_stock;
      `,
    },
    {
      sql: `
        CREATE TRIGGER trg_stock_batches_recompute_ins
        AFTER INSERT ON stock_batches
        FOR EACH ROW
        BEGIN
          INSERT INTO item_stock (id, item_id, location_id, quantity)
          VALUES (
            NEW.item_id || '|' || NEW.location_id, NEW.item_id, NEW.location_id,
            (SELECT COALESCE(SUM(quantity), 0) FROM stock_batches
              WHERE item_id = NEW.item_id AND location_id = NEW.location_id)
          )
          ON CONFLICT(id) DO UPDATE SET quantity = excluded.quantity
          WHERE item_stock.quantity <> excluded.quantity;
        END;
      `,
    },
    {
      sql: `
        CREATE TRIGGER trg_stock_batches_recompute_upd
        AFTER UPDATE ON stock_batches
        FOR EACH ROW
        BEGIN
          UPDATE item_stock
          SET quantity = (SELECT COALESCE(SUM(quantity), 0) FROM stock_batches
                           WHERE item_id = NEW.item_id AND location_id = NEW.location_id)
          WHERE id = NEW.item_id || '|' || NEW.location_id
            AND quantity <> (SELECT COALESCE(SUM(quantity), 0) FROM stock_batches
                              WHERE item_id = NEW.item_id AND location_id = NEW.location_id);
        END;
      `,
    },
    {
      sql: `
        CREATE TRIGGER trg_stock_batches_recompute_del
        AFTER DELETE ON stock_batches
        FOR EACH ROW
        BEGIN
          UPDATE item_stock
          SET quantity = (SELECT COALESCE(SUM(quantity), 0) FROM stock_batches
                           WHERE item_id = OLD.item_id AND location_id = OLD.location_id)
          WHERE id = OLD.item_id || '|' || OLD.location_id
            AND quantity <> (SELECT COALESCE(SUM(quantity), 0) FROM stock_batches
                              WHERE item_id = OLD.item_id AND location_id = OLD.location_id);
        END;
      `,
    },
    { sql: `ALTER TABLE checkouts ADD COLUMN source_batch_key TEXT;` },
    {
      sql: `ALTER TABLE maintenance_schedules ADD COLUMN location_id TEXT REFERENCES locations(id);`,
    },
    { sql: `ALTER TABLE item_attachments ADD COLUMN origin_device_id TEXT;` },
    { sql: `ALTER TABLE locations ADD COLUMN description TEXT;` },
    { sql: `ALTER TABLE locations ADD COLUMN color TEXT;` },
    { sql: `ALTER TABLE projects ADD COLUMN budget REAL;` },
    {
      sql: `
        CREATE TABLE project_budget_categories (
          id         TEXT    PRIMARY KEY NOT NULL,
          project_id TEXT    NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
          name       TEXT    NOT NULL,
          amount     REAL    NOT NULL DEFAULT 0,
          position   INTEGER NOT NULL DEFAULT 0,
          created_at INTEGER NOT NULL DEFAULT (${SQL_NOW_MS}),
          updated_at INTEGER NOT NULL DEFAULT (${SQL_NOW_MS}),
          CHECK (amount >= 0)
        ) STRICT;
      `,
    },
    {
      sql: `CREATE INDEX idx_project_budget_categories_project_id
              ON project_budget_categories(project_id, position);`,
    },
    { sql: updatedAtTrigger('project_budget_categories') },
    {
      sql: `
        CREATE TABLE project_expenses (
          id          TEXT    PRIMARY KEY NOT NULL,
          project_id  TEXT    NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
          category_id TEXT    REFERENCES project_budget_categories(id) ON DELETE SET NULL,
          description TEXT,
          amount      REAL    NOT NULL DEFAULT 0,
          incurred_at INTEGER NOT NULL DEFAULT (${SQL_NOW_MS}),
          created_at  INTEGER NOT NULL DEFAULT (${SQL_NOW_MS}),
          updated_at  INTEGER NOT NULL DEFAULT (${SQL_NOW_MS}),
          CHECK (amount >= 0)
        ) STRICT;
      `,
    },
    {
      sql: `CREATE INDEX idx_project_expenses_project_id
              ON project_expenses(project_id, incurred_at);`,
    },
    {
      sql: `CREATE INDEX idx_project_expenses_category_id ON project_expenses(category_id);`,
    },
    { sql: updatedAtTrigger('project_expenses') },
    { sql: `ALTER TABLE items ADD COLUMN reorder_point INTEGER;` },
    { sql: `ALTER TABLE items ADD COLUMN reorder_gauge_percent REAL;` },
    { sql: `ALTER TABLE items ADD COLUMN reorder_qty INTEGER;` },
    {
      sql: `
        CREATE TABLE supplier_parts (
          id            TEXT    PRIMARY KEY NOT NULL,
          item_id       TEXT    NOT NULL REFERENCES items(id) ON DELETE CASCADE,
          supplier_name TEXT    NOT NULL,
          order_code    TEXT,
          unit_cost     REAL,
          currency      TEXT,
          pack_qty      INTEGER,
          min_order_qty INTEGER,
          price_breaks  TEXT,
          url           TEXT,
          is_preferred  INTEGER NOT NULL DEFAULT 0,
          created_at    INTEGER NOT NULL DEFAULT (${SQL_NOW_MS}),
          updated_at    INTEGER NOT NULL DEFAULT (${SQL_NOW_MS}),
          CHECK (is_preferred IN (0, 1)),
          CHECK (unit_cost IS NULL OR unit_cost >= 0),
          CHECK (pack_qty IS NULL OR pack_qty > 0),
          CHECK (min_order_qty IS NULL OR min_order_qty > 0)
        ) STRICT;
      `,
    },
    {
      sql: `CREATE INDEX idx_supplier_parts_item_id
              ON supplier_parts(item_id, is_preferred DESC, supplier_name COLLATE NOCASE);`,
    },
    { sql: updatedAtTrigger('supplier_parts') },
    {
      sql: `
        CREATE TABLE purchase_orders (
          id            TEXT    PRIMARY KEY NOT NULL,
          supplier_name TEXT    NOT NULL,
          reference     TEXT,
          status        TEXT    NOT NULL DEFAULT 'DRAFT',
          currency      TEXT,
          created_at    INTEGER NOT NULL DEFAULT (${SQL_NOW_MS}),
          ordered_at    INTEGER,
          updated_at    INTEGER NOT NULL DEFAULT (${SQL_NOW_MS}),
          CHECK (status IN ('DRAFT', 'ORDERED', 'PARTIAL', 'RECEIVED', 'CANCELLED'))
        ) STRICT;
      `,
    },
    {
      sql: `
        CREATE TABLE purchase_order_lines (
          id               TEXT    PRIMARY KEY NOT NULL,
          po_id            TEXT    NOT NULL REFERENCES purchase_orders(id) ON DELETE CASCADE,
          item_id          TEXT    REFERENCES items(id) ON DELETE SET NULL,
          supplier_part_id TEXT    REFERENCES supplier_parts(id) ON DELETE SET NULL,
          description      TEXT,
          ordered_qty      INTEGER NOT NULL,
          received_qty     INTEGER NOT NULL DEFAULT 0,
          unit_cost        REAL,
          created_at       INTEGER NOT NULL DEFAULT (${SQL_NOW_MS}),
          updated_at       INTEGER NOT NULL DEFAULT (${SQL_NOW_MS}),
          CHECK (ordered_qty > 0),
          CHECK (received_qty >= 0),
          CHECK (unit_cost IS NULL OR unit_cost >= 0)
        ) STRICT;
      `,
    },
    {
      sql: `CREATE INDEX idx_purchase_order_lines_po_id ON purchase_order_lines(po_id);`,
    },
    {
      sql: `CREATE INDEX idx_purchase_order_lines_item_id ON purchase_order_lines(item_id);`,
    },
    { sql: updatedAtTrigger('purchase_orders') },
    { sql: updatedAtTrigger('purchase_order_lines') },
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
