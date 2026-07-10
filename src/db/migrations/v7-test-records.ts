import { SQL_NOW_MS, type Migration } from './migration';

/**
 * v7 — Per-instance test / calibration / service records (feature-gap G7).
 *
 * Maintenance schedules (`maintenance_schedules`, §4.3) answer "when is this due next"; the
 * Activity Log records free-form maintenance notes. Neither captures the **structured pass/fail +
 * reading log** a lab / maker / calibration house keeps against one serialised unit — "insulation
 * resistance: Pass, 12.5 MΩ", "annual calibration: Marginal, 0.4 % drift". This step adds that log
 * (InvenTree "test result" parity), keyed to a serialised item.
 *
 * One additive change: a new `test_records` table, an append-only LWW leaf (carries `updated_at` +
 * the auto-stamp trigger) so it merges by ordinary last-writer-wins like `revaluations`. It is a
 * per-item child — `item_id REFERENCES items(id) ON DELETE CASCADE` — so it joins `SYNC_TABLES` and
 * gains a reconcile `FK_REFS` item guard (like `revaluations`), and a random-UUID primary key
 * (there is no natural business key: two "insulation test" records on the same unit are legitimately
 * distinct). Its shape follows the established closed-vocabulary-as-free-TEXT decision:
 *
 *  - `kind` — `TEST` | `CALIBRATION` | `SERVICE`, defaulting to `TEST`.
 *  - `result` — `PASS` | `FAIL` | `LIMIT` | `NA`, defaulting to `PASS`.
 *
 *    Both are **free TEXT with no DB CHECK** (like `item_relations.kind` / `wishlist.priority` /
 *    `item_history.action`), enforced in the app layer (`normaliseTestRecordKind` /
 *    `normaliseTestResult`), so a future kind/result added by a newer peer syncs forward without a
 *    schema change or a rejected INSERT.
 *  - `reading` — an optional numeric measured value. Deliberately **unconstrained** (no CHECK): a
 *    reading can legitimately be negative (temperature, dBm, drift), unlike a price.
 *  - `unit` / `note` — optional free text.
 *  - `performed_at` — the effective date of the record (UNIX-ms), mirroring `revaluations.revalued_at`.
 *
 * Purely additive, so this appends cleanly as a forward migration (the v1 golden baseline stays
 * untouched); it ships as version 7. A database at v1–v6 gains the table by running this step; a
 * fresh install builds it here on top of the v1 baseline.
 */
export const v7TestRecords: Migration = {
  version: 7,
  name: 'test-records',
  statements: [
    {
      sql: `
        CREATE TABLE test_records (
          id           TEXT    PRIMARY KEY NOT NULL,
          item_id      TEXT    NOT NULL REFERENCES items(id) ON DELETE CASCADE,
          kind         TEXT    NOT NULL DEFAULT 'TEST',   -- TEST | CALIBRATION | SERVICE (app-enforced)
          name         TEXT    NOT NULL,                  -- the check / test name
          result       TEXT    NOT NULL DEFAULT 'PASS',   -- PASS | FAIL | LIMIT | NA (app-enforced)
          reading      REAL,                              -- optional measured value (may be negative)
          unit         TEXT,                              -- optional unit for the reading (e.g. "MΩ")
          note         TEXT,
          performed_at INTEGER NOT NULL DEFAULT (${SQL_NOW_MS}), -- effective date of the record (UNIX-ms)
          created_at   INTEGER NOT NULL DEFAULT (${SQL_NOW_MS}),
          updated_at   INTEGER NOT NULL DEFAULT (${SQL_NOW_MS})
        ) STRICT;
      `,
    },
    {
      sql: `CREATE INDEX idx_test_records_item_id ON test_records(item_id, performed_at);`,
    },
    {
      sql: `
        CREATE TRIGGER trg_test_records_updated_at
        AFTER UPDATE ON test_records
        FOR EACH ROW
        WHEN NEW.updated_at = OLD.updated_at
        BEGIN
          UPDATE test_records SET updated_at = (${SQL_NOW_MS}) WHERE id = NEW.id;
        END;
      `,
    },
  ],
};
