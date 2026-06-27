import { ATTACHMENT_KINDS, FIELD_TYPES } from '../repositories/constants';
import { SQL_NOW_MS, type Migration } from './migration';

/**
 * v3 — Category schemas, tags, images & datasheet pointers (spec §4, §4.2, Phase 3).
 *
 * Adds, all as additive DDL (no table recreation needed):
 *  - `category_fields` — dynamic custom-field *definitions* per category (§4
 *    "Categories & Schema Evolution"), with an optional `default_value` powering
 *    **lenient defaulting** at read time.
 *  - `item_field_values` — the normalised EAV store of an item's field *values*;
 *    absent rows simply resolve to the field default, so a schema change never
 *    needs to back-fill existing items (§4 lenient defaulting).
 *  - `tags` + `item_tags` — a freeform, case-insensitively de-duplicated tag
 *    dictionary and its item join (§5 freeform tagging).
 *  - `item_images` — the §4.2.2 image table: a tiny `thumbnail_blob` BLOB plus the
 *    `full_res_opfs_path` string pointer. The **Anti-Base64 Directive (§4.2.1)** is
 *    absolute: the high-resolution bytes live as a raw OPFS file, never in the DB.
 *  - `item_attachments` — datasheet pointers: external `URL`s or sync-safe
 *    `LOCAL_POINTER` path strings (§4 Attachments & Datasheets).
 *  - `items.serial_no` — instance number distinguishing SERIALISED auto-clones (§4).
 *
 * Every syncable table replicates the §7.1 conventions: a `crypto.randomUUID()` TEXT
 * primary key, an `updated_at` UNIX-ms column, and an AFTER UPDATE auto-stamp trigger
 * carrying the `WHEN NEW.updated_at = OLD.updated_at` LWW pass-through guard.
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

const fieldTypeList = FIELD_TYPES.map((t) => `'${t}'`).join(', ');
const attachmentKindList = ATTACHMENT_KINDS.map((k) => `'${k}'`).join(', ');

export const v3Schema: Migration = {
  version: 3,
  name: 'category-schemas-tags-images',
  statements: [
    // --- serialised instance number (additive) ---------------------------------
    { sql: `ALTER TABLE items ADD COLUMN serial_no INTEGER;` },

    // --- category custom-field definitions (§4) --------------------------------
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
    { sql: `CREATE INDEX idx_category_fields_category_id ON category_fields(category_id);` },
    { sql: updatedAtTrigger('category_fields') },

    // --- per-item custom-field values (normalised EAV) -------------------------
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
    { sql: `CREATE INDEX idx_item_field_values_item_id ON item_field_values(item_id);` },
    { sql: `CREATE INDEX idx_item_field_values_field_id ON item_field_values(field_id);` },
    { sql: updatedAtTrigger('item_field_values') },

    // --- freeform tags + item join (§5) ----------------------------------------
    {
      sql: `
        CREATE TABLE tags (
          id         TEXT    PRIMARY KEY NOT NULL,
          name       TEXT    NOT NULL,
          updated_at INTEGER NOT NULL DEFAULT (${SQL_NOW_MS})
        ) STRICT;
      `,
    },
    // Freeform, but de-duplicated case-insensitively so "ESP32" and "esp32" reuse one tag.
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

    // --- item images (§4.2.2 — Anti-Base64 Directive) --------------------------
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
    { sql: `CREATE INDEX idx_item_images_item_id ON item_images(item_id, position);` },
    { sql: updatedAtTrigger('item_images') },

    // --- item attachments / datasheets (§4) ------------------------------------
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
    { sql: `CREATE INDEX idx_item_attachments_item_id ON item_attachments(item_id, position);` },
    { sql: updatedAtTrigger('item_attachments') },
  ],
};
