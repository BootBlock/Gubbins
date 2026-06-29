import { SQL_NOW_MS, type Migration } from './migration';

/**
 * v13 — Per-location stock ledger (spec §4, Phase 25).
 *
 * Phases 9/20/24 modelled an item as a single `location_id` + `quantity`: stock could
 * only ever live in one place. This migration lifts that cap by making a dedicated
 * `item_stock` ledger the **single source of truth** for *where* an item's units sit —
 * one row per (item, location) — and demoting `items.quantity` to a derived projection
 * that always equals `SUM(item_stock.quantity)`. The same item can now hold stock in
 * several locations at once (on-hand on a shelf *and* physically in another drawer).
 *
 * ## Why a real table, not a derived projection
 * Unlike the Phase-20 In-Transit figure or the Phase-22 usage telemetry (both derivable
 * from the SSOT they project), *where physical stock sits* cannot be derived from
 * anything else — it must be persisted. So this is genuine new bookkeeping: a synced
 * `SYNC_TABLES` member resolving by row-level LWW, like every other discrete quantity.
 *
 * ## Deterministic id (no UPSERT collisions across devices)
 * The row id is the deterministic `${item_id}|${location_id}` composite (a UUID can never
 * contain `|`, mirroring the `item_tags` edge-id convention). Two devices that
 * independently place stock of the same item at the same location therefore generate the
 * *same* id, so the LWW UPSERT (`ON CONFLICT(id)`) merges them instead of tripping a
 * UNIQUE collision — and the migration backfill produces byte-identical rows on every
 * device, so the first post-v13 sync is a no-op.
 *
 * ## items.quantity stays consistent via triggers (zero sync-engine change)
 * `trg_item_stock_recompute_*` recompute `items.quantity = SUM(item_stock.quantity)` after
 * any item_stock insert/update/delete — so the projection is correct after a *repository*
 * write **and** after the sync engine upserts item_stock rows (item_stock is ordered after
 * items in `SYNC_TABLES`, so its trigger always has the final word, even if a cross-merge
 * upserted a stale items.quantity first). Each recompute is guarded by `quantity <> SUM`, so
 * a *no-op* recompute (create, or a same-quantity sync apply) writes nothing and never
 * advances `items.updated_at` — only a genuine quantity change bumps the stamp, exactly as a
 * direct quantity write always did pre-Phase-25 (quantity is an LWW field, §7.3). That guard
 * also avoids perturbing the synced timestamp during reconcile (which would flip LWW on a
 * concurrent field edit). The canonical `trg_items_updated_at` is left untouched: recreating
 * it would reorder it after the v5 `items_fts_au` trigger and corrupt the FTS5 index.
 *
 * Entirely additive — one new table plus its triggers; no §2.3.3 12-step recreation.
 */
export const v13ItemStock: Migration = {
  version: 13,
  name: 'item-stock-ledger',
  statements: [
    // --- The per-location stock ledger (the new SSOT for "where the units are") ---
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
    { sql: `CREATE INDEX idx_item_stock_location_id ON item_stock(location_id);` },

    // Canonical LWW auto-stamp (§7.1): a real modification bumps updated_at.
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

    // --- Backfill: one ledger row per existing item, at its current location -------
    // Deterministic id + the item's own timestamps, so every device produces an
    // identical row and the first post-v13 sync carries no spurious change. Runs
    // BEFORE the recompute triggers exist, so it cannot bump items.updated_at.
    {
      sql: `
        INSERT INTO item_stock (id, item_id, location_id, quantity, created_at, updated_at)
        SELECT id || '|' || location_id, id, location_id, quantity, created_at, updated_at
        FROM items;
      `,
    },

    // --- Keep items.quantity = SUM(item_stock.quantity) at all times --------------
    // The `quantity <> (SELECT SUM…)` guard makes a *no-op* recompute touch nothing: on
    // create (items.quantity is already the seeded value) and on a same-quantity sync
    // apply, the UPDATE does not fire, so it neither re-indexes FTS nor advances
    // items.updated_at — only a genuine quantity change writes the row (and bumps the
    // stamp, exactly as a direct quantity write always did: quantity is an LWW field).
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
  ],
};
