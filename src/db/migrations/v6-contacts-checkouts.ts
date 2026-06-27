import { SQL_NOW_MS, type Migration } from './migration';

/**
 * v6 — Contacts dictionary & Borrowing / Checking Out (spec §4 "Borrowing &
 * Checking Out", Phase 6).
 *
 * All additive DDL (two brand-new tables; no table recreation, so the §2.3.3
 * 12-step pattern is not needed):
 *
 *  - `contacts` — the §4 dedicated "Contacts dictionary" tracking who has what.
 *    Adding a contact must be extremely low-friction (typing a new name in the
 *    checkout box auto-creates it), so `name` carries a case-insensitive UNIQUE
 *    index: the repository does a lookup-or-create against it rather than forcing
 *    the user to a separate setup screen.
 *
 *  - `checkouts` — one row per borrow event. `quantity` units of an item are lent
 *    to a contact, with an optional `due_date` (§4 Due Dates, for overdue
 *    dashboard alerts). `returned_at` is NULL while the item is still out and set
 *    when returned — so a checkout's OPEN/RETURNED status is *derived* from one
 *    nullable column, keeping the §7.1 LWW model a simple last-write-wins.
 *
 * Both tables replicate the §7.1 conventions: a `crypto.randomUUID()` TEXT primary
 * key, an `updated_at` UNIX-ms column, and an AFTER UPDATE auto-stamp trigger
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

export const v6ContactsCheckouts: Migration = {
  version: 6,
  name: 'contacts-borrowing-checkout',
  statements: [
    // --- contacts dictionary (§4 Borrowing & Checking Out) ---------------------
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
    // One contact per name (case-insensitive) so low-friction auto-create resolves
    // to a single existing contact instead of spawning duplicates.
    { sql: `CREATE UNIQUE INDEX idx_contacts_name ON contacts(name COLLATE NOCASE);` },
    { sql: updatedAtTrigger('contacts') },

    // --- checkouts / borrow records (§4 Due Dates) -----------------------------
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
    // Open checkouts (the overdue/who-has-what views) are the hot query: index only
    // the rows still out so the partial index stays tiny.
    {
      sql: `CREATE INDEX idx_checkouts_open ON checkouts(due_date) WHERE returned_at IS NULL;`,
    },
    { sql: updatedAtTrigger('checkouts') },
  ],
};
