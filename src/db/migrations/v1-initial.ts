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
 * v1 — Consolidated baseline schema (the sole migration).
 *
 * This single migration builds the **entire current schema** in one step. Gubbins is
 * pre-release with disposable developer-only data, so it carries no incremental upgrade
 * path from any older on-disk version: every historical migration — the original v1…v24
 * chain and the later forward steps v2 (`idx_items_warranty`), v3
 * (`idx_items_active_location`), v4 (`revaluations` + `items.current_value`, G9), v5
 * (`item_relations`, G6), v6 (`wishlist`, G8) and v7 (`test_records`, G7) — is folded into
 * this one baseline, so a fresh install builds the whole schema here and the target schema
 * version is simply 1. A database left ahead of v1 (e.g. a pre-squash install stranded on a
 * former forward chain) exceeds the target and is refused at boot with `SCHEMA_TOO_NEW`,
 * whose rescue screen offers the local-data reset. The migration *engine*
 * (`runMigrations`/`getUserVersion`/the strict-contiguity guard) and all its sync wiring
 * (`SYNC_TABLES`, `FK_REFS`) are unchanged.
 *
 * ## Zero schema drift — a hard contract
 * The folded forward-step statements (marked "Folded former vN" below) are re-issued
 * verbatim at the tail — purely additive indexes, columns and child tables — so the
 * resulting schema is byte-for-byte identical to what the former chain produced, only now
 * reached in one step at `user_version = 1`. ALTER-added columns are re-issued as ALTERs in
 * their original positions (SQLite stores such columns verbatim at the tail of the table's
 * stored `sql`). The `v1-initial.test.ts` golden-equivalence test locks the result against
 * the committed `__fixtures__/schema-baseline.snapshot.json`, so any *unintended* schema
 * change still fails loudly.
 *
 * The per-phase grouping is preserved as authored: tables come before the
 * children that reference them, triggers after their tables, the FTS index after its
 * `items` content table, and the recompute triggers after their ledgers — the
 * dependency order the chain already ran in. The `SQL_NOW_MS` epoch expression, the
 * `updatedAtTrigger()` helper, and the CHECK-list constants (`FIELD_TYPES`,
 * `ATTACHMENT_KINDS`, …) are reused exactly as the originals did, so the enum CHECKs
 * stay in lock-step with the application constants.
 *
 * Trigger semantics: on UPDATE the auto-stamp trigger stamps `updated_at` **only when the
 * caller left it unchanged**. An UPDATE that sets `updated_at` explicitly (as the §7.3 sync
 * engine does, applying a remote Last-Write-Wins value) is passed through untouched — exactly
 * the behaviour LWW reconciliation needs. The stamp is now `MAX(now, OLD.updated_at + 1)` so an
 * edit is always strictly newer than the row it derived from even when the wall clock is too
 * coarse to show it — see {@link updatedAtTrigger}. Every syncable table now uses that one
 * helper (the six that formerly inlined an identical trigger were folded onto it), so the
 * monotonic guarantee can never again be applied to some tables and missed on others.
 */

/**
 * Build the canonical auto-stamp trigger for a syncable table keyed by `id` (§7.1).
 *
 * `MAX(now, OLD.updated_at + 1)` — never merely `now` — because the wall clock is too coarse
 * to order an edit against the row it edited. `unixepoch('now','subsec')` reports milliseconds,
 * but the underlying system clock ticks far more slowly (~15.6ms on Windows), so an edit made
 * shortly after the row was written or pulled reads back the *same* millisecond. That makes the
 * edit invisible to §7.3 Last-Write-Wins, which resolves an equal-timestamp pair in favour of
 * the remote — silently discarding the edit on the very next sync. Forcing the stamp strictly
 * past `OLD.updated_at` keeps an edit provably newer than what it derived from, whatever the
 * clock's resolution, so causality survives even when wall time cannot express it.
 */
function updatedAtTrigger(table: string): string {
  return `
    CREATE TRIGGER trg_${table}_updated_at
    AFTER UPDATE ON ${table}
    FOR EACH ROW
    WHEN NEW.updated_at = OLD.updated_at
    BEGIN
      UPDATE ${table} SET updated_at = MAX((${SQL_NOW_MS}), OLD.updated_at + 1) WHERE id = NEW.id;
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
          id                      TEXT    PRIMARY KEY NOT NULL,
          name                    TEXT    NOT NULL,
          -- Optional decorative Unicode glyph/emoji (issue #83). When set, an item in this
          -- category shows it as a faint greyscale watermark on its Visual card. Purely
          -- presentational; nullable (no glyph). Stored verbatim as the emoji character(s).
          glyph                   TEXT,
          -- Optional category template default (backlog T1): soft-prefills a new item's
          -- tracking mode in the create form. Nullable (no default); constrained to the
          -- TRACKING_MODES SSOT exactly as items.tracking_mode is.
          default_tracking_mode   TEXT,
          -- Optional category template defaults (backlog T2): soft-prefill a new item's
          -- lifecycle facets on the create form. Both nullable (no default).
          --  · default_condition       — mirrors items.condition (CONDITIONS SSOT).
          --  · default_warranty_months — a warranty *window* in whole months; the create
          --    form turns it into an expiry date (acquired-on + N months) at submit.
          default_condition       TEXT,
          default_warranty_months INTEGER,
          -- Optional category template default maintenance schedule (backlog T2a). Unlike the
          -- soft-prefill facets above, this is *applied* after item create as a
          -- maintenance_schedules row (the item create paths honour it) rather than pre-filling a
          -- form field. Columns mirror maintenance_schedules and are independently nullable:
          --  · default_maintenance_basis          — TIME|USAGE (MAINTENANCE_BASES SSOT).
          --  · default_maintenance_interval_days  — TIME interval in days (mirrors interval_days).
          --  · default_maintenance_interval_usage — USAGE interval in units (mirrors interval_usage).
          -- The application step requires a basis *and* its matching interval both set, so a
          -- half-configured default (basis without an interval) is simply a no-op — hence no
          -- cross-column coherence CHECK, keeping partial LWW updates from the editor legal.
          default_maintenance_basis          TEXT,
          default_maintenance_interval_days  INTEGER,
          default_maintenance_interval_usage REAL,
          updated_at              INTEGER NOT NULL DEFAULT (${SQL_NOW_MS}),
          CHECK (default_tracking_mode IS NULL OR default_tracking_mode IN (${trackingModeList})),
          CHECK (default_condition IS NULL OR default_condition IN (${conditionList})),
          CHECK (default_warranty_months IS NULL OR default_warranty_months > 0),
          CHECK (default_maintenance_basis IS NULL OR default_maintenance_basis IN (${basisList})),
          CHECK (default_maintenance_interval_days IS NULL OR default_maintenance_interval_days > 0),
          CHECK (default_maintenance_interval_usage IS NULL OR default_maintenance_interval_usage > 0)
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
          notes                TEXT,
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
          is_unlimited         INTEGER NOT NULL DEFAULT 0,
          is_favourite         INTEGER NOT NULL DEFAULT 0,
          created_at           INTEGER NOT NULL DEFAULT (${SQL_NOW_MS}),
          updated_at           INTEGER NOT NULL DEFAULT (${SQL_NOW_MS}),
          CHECK (tracking_mode IN (${trackingModeList})),
          CHECK (is_active IN (0, 1)),
          CHECK (quantity >= 0),
          CHECK (tracking_mode <> 'SERIALISED' OR quantity = 1),
          -- "Unlimited supply" (Phase 82) is a DISCRETE-only modifier: an item whose
          -- source is effectively infinite (tap water, mains air). The first CHECK keeps
          -- it a strict boolean; the second is the invariant that it can only sit on a
          -- DISCRETE item, mirroring the SERIALISED-quantity CHECK above.
          CHECK (is_unlimited IN (0, 1)),
          CHECK (is_unlimited = 0 OR tracking_mode = 'DISCRETE'),
          -- "Favourite" (issue #23): a user-pinned item that sorts ahead of the rest of the
          -- list. Applies to any item regardless of tracking mode, so — unlike is_unlimited —
          -- it carries only the strict-boolean CHECK, no mode restriction.
          CHECK (is_favourite IN (0, 1)),
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
          description   TEXT,                          -- optional help note shown on the item control
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
        CREATE TABLE location_tags (
          location_id TEXT NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
          tag_id      TEXT NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
          PRIMARY KEY (location_id, tag_id)
        ) STRICT;
      `,
    },
    { sql: `CREATE INDEX idx_location_tags_tag_id ON location_tags(tag_id);` },
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
    // Retail barcode (GTIN — EAN/UPC): an item's own scannable article code, distinct
    // from the MPN and stored verbatim as printed. Indexed for the scanner's exact
    // lookup-by-barcode, and (below) FTS-indexed like the MPN so a barcode typed into
    // the main search finds its item.
    { sql: `ALTER TABLE items ADD COLUMN barcode TEXT;` },
    { sql: `CREATE INDEX idx_items_barcode ON items(barcode COLLATE NOCASE);` },
    // Intrinsic serial number (issue #90): the maker's unique per-unit identifier printed on
    // the article (distinct from `serial_no`, which is only a SERIALISED-clone instance index).
    // Stored verbatim; indexed for exact lookup and (below) FTS-indexed like the barcode so a
    // serial typed into the main search finds its item.
    { sql: `ALTER TABLE items ADD COLUMN serial_number TEXT;` },
    { sql: `CREATE INDEX idx_items_serial_number ON items(serial_number COLLATE NOCASE);` },
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
          -- Optional icon: a canonical Lucide glyph name (PascalCase), or NULL for the default.
          icon         TEXT,
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
          name, description, notes, mpn, manufacturer, barcode, serial_number,
          content='items',
          content_rowid='rowid'
        );
      `,
    },
    {
      sql: `
        CREATE TRIGGER items_fts_ai AFTER INSERT ON items BEGIN
          INSERT INTO items_fts(rowid, name, description, notes, mpn, manufacturer, barcode, serial_number) VALUES (new.rowid, new.name, new.description, new.notes, new.mpn, new.manufacturer, new.barcode, new.serial_number);
        END;
      `,
    },
    {
      sql: `
        CREATE TRIGGER items_fts_ad AFTER DELETE ON items BEGIN
          INSERT INTO items_fts(items_fts, rowid, name, description, notes, mpn, manufacturer, barcode, serial_number)
          VALUES ('delete', old.rowid, old.name, old.description, old.notes, old.mpn, old.manufacturer, old.barcode, old.serial_number);
        END;
      `,
    },
    {
      sql: `
        CREATE TRIGGER items_fts_au AFTER UPDATE ON items BEGIN
          INSERT INTO items_fts(items_fts, rowid, name, description, notes, mpn, manufacturer, barcode, serial_number)
          VALUES ('delete', old.rowid, old.name, old.description, old.notes, old.mpn, old.manufacturer, old.barcode, old.serial_number);
          INSERT INTO items_fts(rowid, name, description, notes, mpn, manufacturer, barcode, serial_number) VALUES (new.rowid, new.name, new.description, new.notes, new.mpn, new.manufacturer, new.barcode, new.serial_number);
        END;
      `,
    },
    { sql: `INSERT INTO items_fts(items_fts) VALUES ('rebuild');` },
    {
      sql: `
        CREATE TABLE contacts (
          id           TEXT    PRIMARY KEY NOT NULL,
          name         TEXT    NOT NULL,
          note         TEXT,
          phone_mobile TEXT,
          phone_home   TEXT,
          email        TEXT,
          address      TEXT,
          created_at   INTEGER NOT NULL DEFAULT (${SQL_NOW_MS}),
          updated_at   INTEGER NOT NULL DEFAULT (${SQL_NOW_MS})
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
          -- The borrower is a TAGGED UNION (B4): a loan targets exactly one of a contact
          -- (a person), a project ("out on the Henderson job") or a location ("in the van").
          -- All three FKs are nullable and the XOR CHECK below enforces that precisely one is
          -- set. Each cascades on the target's delete, mirroring the contact precedent — the
          -- app returns any open loan first (restoring stock) so a delete never strands stock.
          -- NB: a borrower location_id is the loan TARGET, distinct from source_location_id
          -- (the provenance — where the units were lent FROM), added by a later ALTER below.
          contact_id     TEXT    REFERENCES contacts(id)  ON DELETE CASCADE,
          project_id     TEXT    REFERENCES projects(id)  ON DELETE CASCADE,
          location_id    TEXT    REFERENCES locations(id) ON DELETE CASCADE,
          quantity       INTEGER NOT NULL DEFAULT 1,
          due_date       INTEGER,
          checked_out_at INTEGER NOT NULL DEFAULT (${SQL_NOW_MS}),
          returned_at    INTEGER,
          note           TEXT,
          updated_at     INTEGER NOT NULL DEFAULT (${SQL_NOW_MS}),
          CHECK (quantity > 0),
          CHECK (returned_at IS NULL OR returned_at >= checked_out_at),
          -- Exactly one borrower: contact XOR project XOR location.
          CHECK (
            (contact_id IS NOT NULL) + (project_id IS NOT NULL) + (location_id IS NOT NULL) = 1
          )
        ) STRICT;
      `,
    },
    { sql: `CREATE INDEX idx_checkouts_item_id ON checkouts(item_id);` },
    { sql: `CREATE INDEX idx_checkouts_contact_id ON checkouts(contact_id);` },
    { sql: `CREATE INDEX idx_checkouts_project_id ON checkouts(project_id);` },
    { sql: `CREATE INDEX idx_checkouts_location_id ON checkouts(location_id);` },
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
      // Per-line "picked" flag (issue #121): marks a BOM line physically gathered during
      // the location-aware picking pass, so kitting a project becomes a walk-and-tick-off
      // task ahead of the one-shot finalise. A transient annotation on the line — not a
      // stock movement — so it needs no ledger entry; it syncs LWW like every other line
      // column.
      sql: `ALTER TABLE project_bom_lines ADD COLUMN picked INTEGER NOT NULL DEFAULT 0;`,
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
      sql: updatedAtTrigger('item_stock'),
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
      sql: updatedAtTrigger('stock_batches'),
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
    // A return keeps its own note, distinct from the checkout `note`, so a return remark
    // never overwrites the loan's own note (both ends retain their text). NULL while open.
    { sql: `ALTER TABLE checkouts ADD COLUMN return_note TEXT;` },
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
          is_price_source INTEGER NOT NULL DEFAULT 0,
          created_at    INTEGER NOT NULL DEFAULT (${SQL_NOW_MS}),
          updated_at    INTEGER NOT NULL DEFAULT (${SQL_NOW_MS}),
          CHECK (is_preferred IN (0, 1)),
          CHECK (is_price_source IN (0, 1)),
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
    // --- Intrinsic physical weight (issue #25) -----------------------------------
    // An item's mass, stored canonically in GRAMS (a single REAL column) so weights are
    // directly comparable and summable across items regardless of the unit the user reads
    // them in — the display/entry unit is the `weightUnit` preference, applied only at the
    // edges. Nullable (no weight set); non-negative, mirroring the unit_cost CHECK.
    {
      sql: `ALTER TABLE items ADD COLUMN weight REAL CHECK (weight IS NULL OR weight >= 0);`,
    },
    // --- Intrinsic physical dimensions (issue #30) -------------------------------
    // An item's bounding box: width, height and depth, each stored canonically in
    // MILLIMETRES (a REAL column apiece) so dimensions are directly comparable across
    // items regardless of the unit the user reads them in — the display/entry unit is the
    // `dimensionUnit` preference, applied only at the edges. Each is nullable (not tracked)
    // and non-negative, mirroring the weight CHECK.
    {
      sql: `ALTER TABLE items ADD COLUMN width REAL CHECK (width IS NULL OR width >= 0);`,
    },
    {
      sql: `ALTER TABLE items ADD COLUMN height REAL CHECK (height IS NULL OR height >= 0);`,
    },
    {
      sql: `ALTER TABLE items ADD COLUMN depth REAL CHECK (depth IS NULL OR depth >= 0);`,
    },
    // --- Folded former v2: asset bookings (Phase 78) ------------------------------
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
    { sql: updatedAtTrigger('asset_bookings') },
    // --- Folded former v3: supplier price history (Phase 81) ----------------------
    {
      sql: `
        CREATE TABLE supplier_part_price_history (
          id               TEXT    PRIMARY KEY NOT NULL,
          supplier_part_id TEXT    NOT NULL REFERENCES supplier_parts(id) ON DELETE CASCADE,
          unit_cost        REAL    NOT NULL,                  -- the recorded cost at recorded_at
          currency         TEXT,                              -- null ⇒ base currency
          source           TEXT    NOT NULL DEFAULT 'MANUAL', -- 'MANUAL' | 'SCRAPE'
          recorded_at      INTEGER NOT NULL DEFAULT (${SQL_NOW_MS}),
          updated_at       INTEGER NOT NULL DEFAULT (${SQL_NOW_MS}),
          CHECK (unit_cost >= 0),
          CHECK (source IN ('MANUAL', 'SCRAPE'))
        ) STRICT;
      `,
    },
    {
      sql: `CREATE INDEX idx_supplier_part_price_history_part
              ON supplier_part_price_history(supplier_part_id, recorded_at);`,
    },
    { sql: updatedAtTrigger('supplier_part_price_history') },
    // --- Folded former v4: richer location metadata -------------------------------
    { sql: `ALTER TABLE locations ADD COLUMN kind TEXT;` },
    {
      sql: `ALTER TABLE locations ADD COLUMN capacity INTEGER CHECK (capacity IS NULL OR capacity >= 0);`,
    },
    {
      sql: `ALTER TABLE locations ADD COLUMN is_default INTEGER NOT NULL DEFAULT 0 CHECK (is_default IN (0, 1));`,
    },
    { sql: `ALTER TABLE locations ADD COLUMN archived_at INTEGER;` },
    // --- Stock-take G1: durable "last counted" timestamp -------------------------
    { sql: `ALTER TABLE locations ADD COLUMN last_counted_at INTEGER;` },
    // --- Kits / bundles (v1: definition + availability) ---------------------------
    // A kit is a reusable many-to-many item→component definition: the `kit_item_id`
    // item is *composed of* `quantity` units of each `component_item_id` item (e.g. a
    // first-aid kit = 2 bandages + 1 scissors). Distinct from variants (child SKUs of
    // one identity) and a project BOM (transient work). Both FKs cascade-delete from
    // `items`, so deleting either the kit or a component prunes the edge. The
    // self-reference CHECK blocks the trivial one-hop cycle; deeper transitive cycles
    // are rejected by the repository's recursive-CTE validator (a DB CHECK cannot walk
    // the graph). Not in SYNC_TABLES for v1 — kit definitions are device-local until the
    // assemble/disassemble v2 work, which is when their propagation is designed.
    {
      sql: `
        CREATE TABLE kit_components (
          id                TEXT    PRIMARY KEY NOT NULL,
          kit_item_id       TEXT    NOT NULL REFERENCES items(id) ON DELETE CASCADE,
          component_item_id TEXT    NOT NULL REFERENCES items(id) ON DELETE CASCADE,
          quantity          INTEGER NOT NULL DEFAULT 1,
          sort              INTEGER NOT NULL DEFAULT 0,
          created_at        INTEGER NOT NULL DEFAULT (${SQL_NOW_MS}),
          updated_at        INTEGER NOT NULL DEFAULT (${SQL_NOW_MS}),
          CHECK (quantity > 0),
          CHECK (kit_item_id <> component_item_id),
          UNIQUE (kit_item_id, component_item_id)
        ) STRICT;
      `,
    },
    { sql: `CREATE INDEX idx_kit_components_kit_item_id ON kit_components(kit_item_id, sort);` },
    {
      sql: `CREATE INDEX idx_kit_components_component_item_id ON kit_components(component_item_id);`,
    },
    { sql: updatedAtTrigger('kit_components') },
    // --- Folded former v2: partial index on items.warranty_expires_at -------------
    // Most items carry no warranty date, so the index is partial (mirrors idx_items_expiry):
    // the warranty-attention probe / listWarrantyExpiring / alert centre seek the small set
    // that actually has one rather than scanning the whole items table.
    {
      sql: `CREATE INDEX idx_items_warranty ON items(warranty_expires_at) WHERE warranty_expires_at IS NOT NULL;`,
    },
    // --- Folded former v3: partial index on items(location_id) WHERE is_active = 1 -
    // The hot per-location active-stock reads emit `WHERE is_active = 1 AND location_id = ?`.
    // Encoding `is_active = 1` in the index's WHERE (rather than a composite second column)
    // keeps it single-column and makes the no-stats planner prefer it for exactly this query.
    {
      sql: `CREATE INDEX idx_items_active_location ON items(location_id) WHERE is_active = 1;`,
    },
    // --- Folded former v4: manual current value + revaluation log (feature-gap G9) -
    // Additive: a live manual per-unit value on items, plus an append-only LWW log of the
    // valuation points that set it (value can move up or down, independent of depreciation).
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
      sql: updatedAtTrigger('revaluations'),
    },
    // --- Folded former v5: related-items cross-links (feature-gap G6) --------------
    // A synced many-to-many relation between items, distinct from variants (items.parent_id)
    // and kits. Deterministic `from|to|kind` primary key so two devices minting the same
    // logical relation converge by LWW; `kind` is app-enforced free TEXT (no DB CHECK).
    {
      sql: `
        CREATE TABLE item_relations (
          id           TEXT    PRIMARY KEY NOT NULL,   -- canonical "from|to|kind" (deterministic)
          from_item_id TEXT    NOT NULL REFERENCES items(id) ON DELETE CASCADE,
          to_item_id   TEXT    NOT NULL REFERENCES items(id) ON DELETE CASCADE,
          kind         TEXT    NOT NULL,               -- WORKS_WITH | ACCESSORY_FOR | SPARE_FOR (app-enforced)
          note         TEXT,                           -- optional free-text context for the link
          created_at   INTEGER NOT NULL DEFAULT (${SQL_NOW_MS}),
          updated_at   INTEGER NOT NULL DEFAULT (${SQL_NOW_MS}),
          CHECK (from_item_id <> to_item_id)
        ) STRICT;
      `,
    },
    {
      sql: `CREATE INDEX idx_item_relations_from ON item_relations(from_item_id);`,
    },
    {
      sql: `CREATE INDEX idx_item_relations_to ON item_relations(to_item_id);`,
    },
    {
      sql: updatedAtTrigger('item_relations'),
    },
    // --- Folded former v6: manual "to-buy" / wishlist (feature-gap G8) -------------
    // A standalone dictionary table (no FK, like contacts/projects) of wanted-but-not-owned
    // things; `priority` is app-enforced free TEXT (HIGH | MEDIUM | LOW | NONE), default NONE.
    {
      sql: `
        CREATE TABLE wishlist (
          id           TEXT    PRIMARY KEY NOT NULL,
          name         TEXT    NOT NULL,
          note         TEXT,                           -- optional free-text context
          url          TEXT,                           -- optional http(s) link (app-sanitised)
          target_price REAL    CHECK (target_price IS NULL OR target_price >= 0),
          priority     TEXT    NOT NULL DEFAULT 'NONE', -- HIGH | MEDIUM | LOW | NONE (app-enforced)
          created_at   INTEGER NOT NULL DEFAULT (${SQL_NOW_MS}),
          updated_at   INTEGER NOT NULL DEFAULT (${SQL_NOW_MS})
        ) STRICT;
      `,
    },
    {
      sql: updatedAtTrigger('wishlist'),
    },
    // --- Folded former v7: per-instance test / calibration / service records (G7) --
    // An append-only LWW child of items (structured pass/fail + reading log per serialised
    // unit). `kind` (TEST | CALIBRATION | SERVICE) and `result` (PASS | FAIL | LIMIT | NA)
    // are app-enforced free TEXT; `reading` is deliberately unconstrained (may be negative).
    {
      sql: `
        CREATE TABLE test_records (
          id           TEXT    PRIMARY KEY NOT NULL,
          item_id      TEXT    NOT NULL REFERENCES items(id) ON DELETE CASCADE,
          kind         TEXT    NOT NULL DEFAULT 'TEST',   -- TEST | CALIBRATION | SERVICE (app-enforced)
          name         TEXT    NOT NULL,                  -- the check / test name
          result       TEXT    NOT NULL DEFAULT 'PASS',   -- PASS | FAIL | LIMIT | NA (app-enforced)
          reading      REAL,                              -- optional measured value (may be negative)
          unit         TEXT,                              -- optional unit for the reading (e.g. "MΩ")
          note         TEXT,
          performed_at INTEGER NOT NULL DEFAULT (${SQL_NOW_MS}), -- effective date of the record (UNIX-ms)
          created_at   INTEGER NOT NULL DEFAULT (${SQL_NOW_MS}),
          updated_at   INTEGER NOT NULL DEFAULT (${SQL_NOW_MS})
        ) STRICT;
      `,
    },
    {
      sql: `CREATE INDEX idx_test_records_item_id ON test_records(item_id, performed_at);`,
    },
    {
      sql: updatedAtTrigger('test_records'),
    },
  ],
};
