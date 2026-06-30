import { SQL_NOW_MS, type Migration } from './migration';

/**
 * v23 — Formal Purchase Orders (spec §4 "The Liminal Space of Procurement",
 * Inventory-depth Phase 62).
 *
 * Adds a supplier-keyed **PO document** spanning multiple items. Procurement previously
 * lived only on a project's BOM line (`Ordered → In-Transit → partial receipt`); this gives
 * Gubbins a first-class order that several lines hang off, each receiving into the existing
 * per-location / per-batch stock machinery (Phase 25 / Phase 28) via the shared receipt seam
 * — never a second stock-mutation path.
 *
 *  - `purchase_orders` — one row per supplier order:
 *      * `supplier_name` — the distributor/supplier the order is placed with.
 *      * `reference`     — the user's PO reference / order number (nullable).
 *      * `status`        — `DRAFT | ORDERED | PARTIAL | RECEIVED | CANCELLED`. Only DRAFT and
 *                          CANCELLED are *user-set authoritative* states; the persisted value
 *                          for an active order is a derived snapshot (received vs ordered) and
 *                          is recomputed by `po-status.ts`, never trusted as the SSOT.
 *      * `currency`      — ISO code; **nullable** ⇒ "use the base currency" (matches
 *                          `supplier_parts`; the spec locks a single base currency, so this is
 *                          stored for fidelity only and is never FX-converted).
 *      * `ordered_at`    — when the order left DRAFT (nullable until ordered).
 *
 *  - `purchase_order_lines` — one row per ordered part on a PO:
 *      * `po_id`            — FK → purchase_orders **ON DELETE CASCADE** (NOT NULL): a line
 *                             cannot outlive its order.
 *      * `item_id`          — FK → items **ON DELETE SET NULL** (nullable): a removed item
 *                             leaves the line (the order history is real) with the link cleared.
 *      * `supplier_part_id` — FK → supplier_parts **ON DELETE SET NULL** (nullable, the
 *                             Phase-60 link): a removed supplier-part nulls the line, never
 *                             blocks the delete.
 *      * `ordered_qty`      — the quantity ordered (> 0, matching the BOM line convention).
 *      * `received_qty`     — accumulates as instalments arrive (mirroring v12 `received_qty`).
 *      * `unit_cost`        — per-unit cost in the PO currency (nullable, ≥ 0 when present).
 *
 * ## Sync
 * Both tables follow the §7.1 conventions verbatim — a `crypto.randomUUID()` TEXT primary key,
 * `created_at`/`updated_at` UNIX-ms columns and the canonical AFTER UPDATE auto-stamp trigger
 * with the LWW pass-through guard. They join `SYNC_TABLES` ordered after `items` /
 * `supplier_parts` (with `purchase_orders` before `purchase_order_lines`) so an UPSERT batch
 * never trips a foreign key. Their `FK_REFS` entries drop a line whose PO did not survive
 * (CASCADE, non-nullable) and NULL a line whose item / supplier-part did not survive (SET NULL,
 * nullable).
 *
 * Entirely additive — two new tables plus their indexes and triggers; no §2.3.3 table
 * recreation.
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

export const v23PurchaseOrders: Migration = {
  version: 23,
  name: 'purchase-orders',
  statements: [
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
  ],
};
