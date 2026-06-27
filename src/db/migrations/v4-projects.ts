import {
  COSTING_MODES,
  IN_TRANSIT_LOCATION_ID,
  IN_TRANSIT_LOCATION_NAME,
  PROCUREMENT_STATUSES,
  PROJECT_STATUSES,
  RESERVATION_STATUSES,
} from '../repositories/constants';
import { SQL_NOW_MS, type Migration } from './migration';

/**
 * v4 — Projects, Reservations, Procurement & BOM Imports (spec §4, Phase 4).
 *
 * All additive DDL (no table recreation, so the §2.3.3 12-step pattern is not
 * needed):
 *  - `items.mpn` / `items.manufacturer` — Manufacturer Part Number + maker, the
 *    auto-match keys for CSV/KiCad BOM ingress (§4 BOM Ingress).
 *  - `items.unit_cost` — current replacement value per unit, powering the
 *    `CURRENT_REPLACEMENT` BOM costing mode (§4 BOM Costing).
 *  - `item_aliases` — supplier/alternative part identifiers mapped to a local item
 *    (§4 Universal Alias Mapping), a secondary BOM auto-match key.
 *  - `projects` — a buildable project carrying its lifecycle status and the costing
 *    mode toggle (Current Replacement vs Point-in-Time, §4 BOM Costing).
 *  - `project_bom_lines` — one row per required part. Reservation state
 *    (Tentative/Actual) and procurement state (Ordered/In-Transit/Received) live on
 *    the line; `unit_cost_snapshot` captures the point-in-time cost (§4).
 *  - the system-locked **"In Transit"** location (§4 "The Liminal Space of
 *    Procurement"), seeded with a fixed sentinel id and `is_system = 1` so the
 *    existing `trg_locations_protect_system_*` guards make it immune to
 *    modification/deletion — exactly mirroring the "Unassigned" pattern.
 *
 * Every syncable table replicates the §7.1 conventions: a `crypto.randomUUID()`
 * TEXT primary key, an `updated_at` UNIX-ms column, and an AFTER UPDATE auto-stamp
 * trigger carrying the `WHEN NEW.updated_at = OLD.updated_at` LWW pass-through guard.
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

const projectStatusList = PROJECT_STATUSES.map((s) => `'${s}'`).join(', ');
const costingModeList = COSTING_MODES.map((m) => `'${m}'`).join(', ');
const reservationStatusList = RESERVATION_STATUSES.map((s) => `'${s}'`).join(', ');
const procurementStatusList = PROCUREMENT_STATUSES.map((s) => `'${s}'`).join(', ');

export const v4Projects: Migration = {
  version: 4,
  name: 'projects-reservations-procurement',
  statements: [
    // --- item BOM-match keys + costing (additive) ------------------------------
    { sql: `ALTER TABLE items ADD COLUMN mpn TEXT;` },
    { sql: `ALTER TABLE items ADD COLUMN manufacturer TEXT;` },
    { sql: `ALTER TABLE items ADD COLUMN unit_cost REAL;` },
    // Case-insensitive MPN lookup for auto-match (NULLs are not indexed/unique-checked).
    { sql: `CREATE INDEX idx_items_mpn ON items(mpn COLLATE NOCASE);` },

    // --- item aliases (§4 Universal Alias Mapping) -----------------------------
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
    // One mapping per alias (case-insensitive) so auto-match is unambiguous.
    { sql: `CREATE UNIQUE INDEX idx_item_aliases_alias ON item_aliases(alias COLLATE NOCASE);` },
    { sql: `CREATE INDEX idx_item_aliases_item_id ON item_aliases(item_id);` },
    { sql: updatedAtTrigger('item_aliases') },

    // --- the system-locked "In Transit" location (§4 procurement) --------------
    {
      sql: `
        INSERT INTO locations (id, name, parent_id, is_system)
        VALUES (?, ?, NULL, 1);
      `,
      params: [IN_TRANSIT_LOCATION_ID, IN_TRANSIT_LOCATION_NAME],
    },

    // --- projects (§4 Projects & BOMs) -----------------------------------------
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

    // --- BOM lines (§4) --------------------------------------------------------
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
    { sql: `CREATE INDEX idx_project_bom_lines_project_id ON project_bom_lines(project_id, position);` },
    { sql: `CREATE INDEX idx_project_bom_lines_item_id ON project_bom_lines(item_id);` },
    { sql: updatedAtTrigger('project_bom_lines') },
  ],
};
