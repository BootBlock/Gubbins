import { SQL_NOW_MS, type Migration } from './migration';

/**
 * v5 — Related-items cross-links (feature-gap G6).
 *
 * A synced many-to-many relation *between items*, distinct from **variants** (`items.parent_id`,
 * child SKUs of one identity) and **kits** (an item assembled from other items): "this camera
 * **works with** that tripod", "this cable **is an accessory for** that laptop", "this belt **is a
 * spare for** that vacuum". Relations are **reciprocal** — a stored A→B row surfaces on B as B→A —
 * so a single directed row reads correctly from either item (see the pure `item-relations.ts` seam).
 *
 * One additive change: a new `item_relations` join table, an LWW leaf (carries `updated_at` + the
 * auto-stamp trigger) so it merges by ordinary last-writer-wins like `revaluations` /
 * `item_aliases`. Its shape follows two deliberate decisions:
 *
 *  - **Deterministic primary key.** `id` is the relation's canonical `from|to|kind` triple (minted
 *    by `itemRelationId`), *not* a random UUID. Two devices that independently add the same logical
 *    relation therefore mint the same `id`, so sync merges them for free — no UNIQUE-business-key
 *    collision that would otherwise need bespoke reconcile handling (contrast `item_aliases`). The
 *    PK doubles as the uniqueness guard, so no extra UNIQUE index is needed.
 *  - **`kind` is free TEXT, no CHECK.** Like `item_history.action`, the small closed vocabulary is
 *    enforced in the app layer (`normaliseRelationKind`), not by a DB CHECK — so a future kind added
 *    by a newer peer syncs forward without a schema change and without a rejected `INSERT`.
 *
 * Both endpoints are `REFERENCES items(id) ON DELETE CASCADE`: deleting either item removes the
 * relation locally, and the sync engine's FK guard (`FK_REFS.item_relations`) drops an incoming
 * relation whose endpoint did not survive the merge. A `from_item_id <> to_item_id` CHECK forbids a
 * self-relation (also rejected upstream by `planRelation`).
 *
 * Purely additive, so this appends cleanly as a forward migration (the v1 golden baseline stays
 * untouched); it ships as version 5. A database at v1–v4 gains the table by running this step; a
 * fresh install builds it here on top of the v1 baseline.
 */
export const v5ItemRelations: Migration = {
  version: 5,
  name: 'item-relations',
  statements: [
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
    // Both directions are queried ("relations touching this item" = from OR to), so index each end.
    {
      sql: `CREATE INDEX idx_item_relations_from ON item_relations(from_item_id);`,
    },
    {
      sql: `CREATE INDEX idx_item_relations_to ON item_relations(to_item_id);`,
    },
    {
      sql: `
        CREATE TRIGGER trg_item_relations_updated_at
        AFTER UPDATE ON item_relations
        FOR EACH ROW
        WHEN NEW.updated_at = OLD.updated_at
        BEGIN
          UPDATE item_relations SET updated_at = (${SQL_NOW_MS}) WHERE id = NEW.id;
        END;
      `,
    },
  ],
};
