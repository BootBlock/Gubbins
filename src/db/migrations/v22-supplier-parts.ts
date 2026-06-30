import { SQL_NOW_MS, type Migration } from './migration';

/**
 * v22 — Supplier parts (spec §4 "External Data Scraping" / supplier facet, Inventory-depth
 * Phase 60).
 *
 * Models **N suppliers per item**. Gubbins previously stored a single MPN / manufacturer /
 * `unitCost` plus the §4 Universal Alias Mapping strings; the direct competitors model many
 * suppliers per part, each with its own order code, unit cost, pack/MOQ and quantity
 * price-breaks. The scraper already *fetches* per-supplier pricing it could not fully store,
 * so this gives it somewhere to land.
 *
 *  - `supplier_parts` — one row per (item, supplier) offer:
 *      * `supplier_name`  — the distributor/supplier (e.g. "DigiKey", "RS").
 *      * `order_code`     — the supplier's order code for this part.
 *      * `unit_cost`      — the per-unit cost in `currency` (REAL, **nullable**: a supplier
 *                           may be recorded without a price).
 *      * `currency`       — ISO code; **nullable** ⇒ "use the base currency". The spec locks
 *                           a single base currency, so this is stored for fidelity only and
 *                           is never FX-converted.
 *      * `pack_qty`       — units per pack (nullable).
 *      * `min_order_qty`  — minimum order quantity (nullable).
 *      * `price_breaks`   — JSON `[{qty,unitCost}]` quantity price-breaks (nullable TEXT).
 *      * `url`            — the supplier product page (nullable).
 *      * `is_preferred`   — 0/1; at most one preferred supplier per item (the repository
 *                           enforces the single-winner invariant in a transaction).
 *
 * The `item_aliases` scan-resolution layer is untouched: a supplier-part may carry the same
 * order code as an alias, but aliases remain the universal scan/search resolution primitive.
 *
 * ## Sync
 * Follows the §7.1 conventions verbatim — a `crypto.randomUUID()` TEXT primary key, an
 * `updated_at` UNIX-ms column and the canonical AFTER UPDATE auto-stamp trigger with the LWW
 * pass-through guard — and joins `SYNC_TABLES` ordered **after `items`** so an UPSERT batch
 * never trips the `item_id` FK. Its `FK_REFS` entry (`item_id → items`, NOT NULL / ON DELETE
 * CASCADE) drops an incoming supplier-part whose item did not survive the merge, mirroring the
 * other item-child cascade guards (`item_aliases`, `capabilities`). All columns sync as shared
 * item state, so none is added to `SYNC_EXCLUDED_COLUMNS`.
 *
 * Entirely additive — one new table plus its index and trigger; no §2.3.3 table recreation.
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

export const v22SupplierParts: Migration = {
  version: 22,
  name: 'supplier-parts',
  statements: [
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
  ],
};
