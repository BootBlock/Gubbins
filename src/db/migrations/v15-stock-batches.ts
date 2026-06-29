import { SQL_NOW_MS, type Migration } from './migration';

/**
 * v15 — Batch / lot-aware per-location stock (spec §4 perishables & traceability, Phase 28).
 *
 * Phase 25 made `item_stock` the SSOT for *where* an item's units sit (one quantity per
 * `(item, location)`). Phase 28 refines a placement so its units can be split across
 * distinct **batches** — a `(batch number, lot number, expiry)` identity each — so a
 * single drawer can hold "5 of lot A (expires June) + 3 of lot B (expires August)". The new
 * `stock_batches` ledger becomes the SSOT one level *below* `item_stock`, and
 * `item_stock.quantity` is demoted to the derived `SUM(stock_batches.quantity)` for that
 * placement — exactly the demotion v13 applied to `items.quantity`, one level down.
 *
 * ## A three-level projection: stock_batches → item_stock → items
 * `trg_stock_batches_recompute_*` keep `item_stock.quantity = SUM(stock_batches.quantity)`
 * per placement; the existing v13 `trg_item_stock_recompute_*` then keep `items.quantity =
 * SUM(item_stock.quantity)`. Each link is guarded by `quantity <> SUM`, so a no-op recompute
 * (a create, or a same-quantity sync apply) writes nothing and never advances `updated_at` /
 * re-indexes FTS / flips LWW — only a genuine change propagates. The canonical
 * `trg_items_updated_at` and the v5 `items_fts_au` external-content trigger are left
 * untouched (recreating them would reorder them and corrupt the FTS5 index).
 *
 * ## Deterministic id (no UPSERT collisions across devices)
 * The row id is `${item_id}|${location_id}|${batch_key}` (the `item_stock` id, suffixed with
 * the canonical batch key — empty for the untracked remainder). The item/location UUIDs
 * contain no `|`, so the id splits unambiguously; two devices recording the same lot at the
 * same placement generate the *same* id and merge by LWW instead of colliding.
 *
 * ## Backfill (byte-identical, first sync a no-op)
 * One **default (untracked) batch** row per existing `item_stock` row — `batch_key = ''`,
 * null batch attributes, carrying the placement's quantity and its own timestamps. The
 * item-level `items.batch_number/lot_number/expiry_date` lifecycle columns (v8) are left in
 * place as the item's headline batch metadata (still driving the §4 expiry alerts); the new
 * per-placement batches are an additive refinement, so nothing is migrated *out* of items and
 * every device produces identical rows.
 *
 * ## Sync
 * `stock_batches` joins `SYNC_TABLES` ordered *after* `item_stock`, so on a cross-device merge
 * its recompute trigger always has the final word on `item_stock.quantity` (and thus
 * `items.quantity`), even if a stale `item_stock` row applied first. Its `location_id` FK gets
 * an `FK_REFS` re-home entry so a removed location's batches move to Unassigned (parallel to
 * `item_stock`). Entirely additive — one new table plus its triggers; no §2.3.3 recreation.
 */
export const v15StockBatches: Migration = {
  version: 15,
  name: 'stock-batches',
  statements: [
    // --- The per-placement batch ledger (new SSOT for "which lots, at which placement") ---
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
    { sql: `CREATE INDEX idx_stock_batches_item_id ON stock_batches(item_id);` },
    { sql: `CREATE INDEX idx_stock_batches_location_id ON stock_batches(location_id);` },
    { sql: `CREATE INDEX idx_stock_batches_placement ON stock_batches(item_id, location_id);` },
    { sql: `CREATE INDEX idx_stock_batches_expiry ON stock_batches(expiry_date);` },

    // Canonical LWW auto-stamp (§7.1): a real modification bumps updated_at.
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

    // --- Backfill: one default (untracked) batch row per existing placement ------------
    // Deterministic id (`<item_stock.id>|`) + the placement's own timestamps, so every
    // device produces an identical row and the first post-v15 sync carries no change. Runs
    // BEFORE the recompute triggers exist, so it cannot perturb item_stock.updated_at.
    {
      sql: `
        INSERT INTO stock_batches (id, item_id, location_id, batch_key, quantity, created_at, updated_at)
        SELECT id || '|', item_id, location_id, '', quantity, created_at, updated_at
        FROM item_stock;
      `,
    },

    // --- Keep item_stock.quantity = SUM(stock_batches.quantity) per placement ----------
    // The INSERT trigger UPSERTs the parent item_stock row (creating it when a batch is
    // received into a placement that had none), so a brand-new placement's total is correct;
    // the guard makes a same-value recompute a no-op. The UPDATE/DELETE triggers only adjust
    // an already-present item_stock row (a batch can only be updated/deleted if its insert
    // created that row); during an item cascade-delete the parent row may already be gone, so
    // the UPDATE simply no-ops. Each recompute then cascades into the v13 item_stock triggers
    // that re-derive items.quantity — a clean, guarded three-level projection.
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
  ],
};
