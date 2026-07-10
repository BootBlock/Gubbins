import { SQL_NOW_MS, type Migration } from './migration';

/**
 * v6 — Manual "to-buy" / wishlist (feature-gap G8).
 *
 * A small manual list of **wanted-but-not-owned** things — distinct from the *stock-driven*
 * reorder / shopping list, which is derived from items below their reorder point. A wishlist
 * entry is free-standing: it references no item (you don't own it yet), just a name plus an
 * optional note, link, target price and priority. It surfaces as a third tab on the Purchase
 * Orders screen, beside Orders and the Reorder / Shopping list.
 *
 * One additive change: a new independent `wishlist` table, an LWW leaf (carries `updated_at` +
 * the auto-stamp trigger) so it merges by ordinary last-writer-wins like `revaluations` /
 * `item_relations`. It has **no foreign key** — it is a standalone dictionary like `contacts` /
 * `projects`, so it needs no `FK_REFS` reconcile entry; a random-UUID primary key (there is no
 * natural business key — two "birthday present" entries are legitimately distinct).
 *
 *  - `priority` is **free TEXT, no CHECK** (like `item_relations.kind` / `item_history.action`):
 *    the small closed vocabulary (`HIGH` / `MEDIUM` / `LOW` / `NONE`) is enforced in the app layer
 *    (`normaliseWishlistPriority`), so a future priority added by a newer peer syncs forward without
 *    a schema change or a rejected INSERT. It defaults to `NONE`.
 *  - `target_price` is nullable with a partial non-negative CHECK, matching `items.current_value`.
 *
 * Purely additive, so this appends cleanly as a forward migration (the v1 golden baseline stays
 * untouched); it ships as version 6. A database at v1–v5 gains the table by running this step; a
 * fresh install builds it here on top of the v1 baseline.
 */
export const v6Wishlist: Migration = {
  version: 6,
  name: 'wishlist',
  statements: [
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
      sql: `
        CREATE TRIGGER trg_wishlist_updated_at
        AFTER UPDATE ON wishlist
        FOR EACH ROW
        WHEN NEW.updated_at = OLD.updated_at
        BEGIN
          UPDATE wishlist SET updated_at = (${SQL_NOW_MS}) WHERE id = NEW.id;
        END;
      `,
    },
  ],
};
