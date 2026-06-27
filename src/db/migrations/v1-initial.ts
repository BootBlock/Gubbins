import { SQL_NOW_MS, type Migration } from './migration';

/**
 * v1 — Baseline schema.
 *
 * Phase 1 deliberately introduces no domain tables (items, locations, categories
 * are Phase 2). It establishes a single foundational key/value `app_meta` table
 * plus the canonical `updated_at` auto-stamp trigger that every syncable Phase 2+
 * table will replicate (spec §7.1).
 *
 * `app_meta` is an intentional, local-only settings store keyed by a semantic
 * string; the UUIDv4 primary-key rule of §7.1 applies to syncable *domain* rows,
 * which arrive in Phase 2. STRICT typing is used throughout for data integrity.
 *
 * Trigger semantics: on UPDATE the trigger stamps `updated_at` to "now" **only
 * when the caller left it unchanged**. An UPDATE that sets `updated_at` explicitly
 * (as the sync engine will, applying a remote Last-Write-Wins value in §7.3) is
 * passed through untouched — exactly the behaviour LWW reconciliation needs.
 */
export const v1Initial: Migration = {
  version: 1,
  name: 'initial-baseline',
  statements: [
    {
      sql: `
        CREATE TABLE app_meta (
          key        TEXT    PRIMARY KEY NOT NULL,
          value      TEXT,
          updated_at INTEGER NOT NULL DEFAULT (${SQL_NOW_MS})
        ) STRICT;
      `,
    },
    {
      sql: `
        CREATE TRIGGER trg_app_meta_updated_at
        AFTER UPDATE ON app_meta
        FOR EACH ROW
        WHEN NEW.updated_at = OLD.updated_at
        BEGIN
          UPDATE app_meta SET updated_at = (${SQL_NOW_MS}) WHERE key = NEW.key;
        END;
      `,
    },
  ],
};
