import { SQL_NOW_MS, type Migration } from './migration';

/**
 * v20 — Project budgeting (spec §4 "Projects & BOMs", Backlog/developer-chosen).
 *
 * Builds an optional budgeting layer on top of the existing §4 BOM costing. The app
 * already *estimates* a project's cost (live or snapshot `getCosting`); this adds the
 * complementary half — what the user has *allotted* and what they have actually *spent*:
 *
 *  - `projects.budget` — an additive, **nullable** overall budget (REAL). NULL means
 *    "no budget set" — the whole feature is opt-in, so every pre-v20 project reads
 *    correctly with no backfill and the budget UI simply offers "Set a budget".
 *
 *  - `project_budget_categories` — optional named sub-budget buckets (e.g. "Parts",
 *    "Shipping", "Labour", "Tools"), each with its own allocated `amount`. A casual
 *    user adds none and sees a single total; a power user splits the budget out.
 *
 *  - `project_expenses` — the manual spend ledger: an explicit recorded cost
 *    (description + `amount` + `incurred_at`), optionally assigned to one budget
 *    category. This captures real spend the derived BOM figure cannot — shipping,
 *    labour, tools, miscellany — alongside the auto-derived `received_qty × unit_cost`
 *    "committed" spend the repository computes live from the BOM (no stored counter, so
 *    it can never drift, mirroring the Phase-20 In-Transit projection).
 *
 * ## Sync
 * Both new tables follow the §7.1 conventions verbatim — a `crypto.randomUUID()` TEXT
 * primary key, an `updated_at` UNIX-ms column and the canonical AFTER UPDATE auto-stamp
 * trigger carrying the LWW pass-through guard — and join `SYNC_TABLES` ordered *after*
 * `projects` (and categories before expenses, so an UPSERT batch never trips the
 * `category_id` FK). Each gets an `FK_REFS` entry: `project_id` mirrors the BOM-line
 * cascade (drop an incoming row whose project was removed), and an expense's nullable
 * `category_id` is cleared if its category did not survive the merge (NO ACTION /
 * SET NULL — the expense stays, it just falls back to "uncategorised"). Both budget
 * columns/tables sync as shared project state, so neither is added to
 * `SYNC_EXCLUDED_COLUMNS`.
 *
 * Entirely additive — one nullable column plus two new tables and their triggers; no
 * §2.3.3 table recreation is needed.
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

export const v20ProjectBudgets: Migration = {
  version: 20,
  name: 'project-budgets',
  statements: [
    // --- optional overall budget on the project (additive, nullable) -------------
    { sql: `ALTER TABLE projects ADD COLUMN budget REAL;` },

    // --- optional named sub-budget buckets ---------------------------------------
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

    // --- the manual expense ledger -----------------------------------------------
    // `category_id` is a nullable FK with ON DELETE SET NULL: removing a category
    // un-categorises its expenses (the spend is still real and counts toward the
    // project total) rather than cascading them away.
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
    { sql: `CREATE INDEX idx_project_expenses_category_id ON project_expenses(category_id);` },
    { sql: updatedAtTrigger('project_expenses') },
  ],
};
