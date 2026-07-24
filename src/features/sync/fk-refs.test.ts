import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createMemoryDriver, type MemoryDriver } from '@/test/drivers/memory-driver';
import { runMigrations } from '@/db/migrations/engine';
import { migrations } from '@/db/migrations';
import { SYNC_TABLES, type SyncTable } from '@/db/repositories';
import { FK_REFS } from './fk-refs';

/**
 * Drift guard (issues #152, #246). Both the reconciliation engine and the backup codec decide
 * what to do about a dangling reference purely from {@link FK_REFS}. Because the map is typed
 * `Partial<Record<SyncTable, …>>` — most tables genuinely need no entry — the compiler gives
 * *no* nudge when a table joins {@link SYNC_TABLES}, so a column the registry does not know about
 * is silently treated as "references nothing". That is how a backup excluding removed items could
 * ship an `item_relations` row pointing at an item the file no longer contains and abort the whole
 * restore on a foreign-key violation (#152).
 *
 * Worse, each entry also asserts a `nullable` flag, and nothing checked it against the real DDL
 * (#246). A wrong flag is a live bug in `enforceForeignKeys`:
 *  - `nullable: true` on a NOT-NULL column → the merge *nulls* a column the schema forbids to be
 *    null, tripping the constraint mid-batch and aborting the whole sync — the exact failure the
 *    map exists to prevent;
 *  - `nullable: false` on a genuinely nullable, kept-on-delete column → the merge *drops* a row it
 *    should have kept with the reference cleared, silently losing data.
 *
 * So rather than trusting the registry by hand, read the real, built schema via
 * `PRAGMA foreign_key_list` + `PRAGMA table_info` and assert every synced-child → synced-parent
 * reference appears in `FK_REFS` with the correct `nullable`, and that the registry carries no
 * stale entry the schema no longer declares.
 */

/** A row of `PRAGMA foreign_key_list(<table>)`. */
interface ForeignKeyRow {
  readonly from: string; // the child column
  readonly table: string; // the parent table
  readonly to: string; // the parent column (always `id` here)
  readonly on_delete: string; // 'CASCADE' | 'SET NULL' | 'NO ACTION' | 'RESTRICT'
}

/** A row of `PRAGMA table_info(<table>)`. */
interface ColumnRow {
  readonly name: string;
  readonly notnull: number; // 1 when the column is declared NOT NULL
}

/** One foreign key of a synced child table pointing at a synced parent table. */
interface SchemaFk {
  readonly table: SyncTable;
  readonly col: string;
  readonly parent: SyncTable;
  readonly onDelete: string;
  readonly notNull: boolean;
}

/**
 * The `nullable` flag `FK_REFS` *must* carry for a schema FK, derived from what
 * `enforceForeignKeys` is allowed to do when the parent did not survive the merge:
 *
 *  - a NOT-NULL column can only be *dropped* (clearing it would trip the constraint) → `false`;
 *  - an `ON DELETE CASCADE` column is dropped even when nullable — the parent's deletion is meant
 *    to take the child with it, so keeping it with a null would resurrect a cascade-deleted row
 *    → `false` (e.g. `checkouts.contact_id`, a nullable column that must still drop);
 *  - any other nullable column (SET NULL / NO ACTION / RESTRICT) is kept with the reference
 *    cleared → `true`.
 *
 * Note this is deliberately *not* the naive `!notnull`: a nullable CASCADE column (`contact_id`)
 * would fool that rule into expecting `true` when `false` is correct.
 */
const expectedNullable = (fk: SchemaFk): boolean => !fk.notNull && fk.onDelete !== 'CASCADE';

/** References the registry omits on purpose, each with the reason it needs no generic repair. */
const EXEMPT: Readonly<Record<string, string>> = {
  // §7.5.2 re-parents an item whose location did not survive to Unassigned instead.
  'items.location_id': 'handled by the §7.5.2 re-parent',
  // Self-referential nesting: resolved by walking the parent chain (to a fixed point here, and
  // by `resolveLocationTarget` / `wouldCreateCycle` for locations), not by the generic
  // parent→child repair — the parent set is the table itself.
  'items.parent_id': 'resolved by walking the variant chain',
  'locations.parent_id': 'resolved by the §7.5.2 re-parent / cycle guard',
  // Known gap, tracked separately: the borrower is a tagged union (contact XOR project XOR
  // location), so a dangling borrower can be neither nulled (it would break the XOR CHECK) nor
  // dropped without deciding what a loan with no borrower means. Backups are unaffected — the
  // only reference `filterSnapshot` can dangle is `item_id`, which is covered by FK_REFS.
  'checkouts.project_id': 'tagged-union borrower; needs its own repair rule',
  'checkouts.location_id': 'tagged-union borrower; needs its own repair rule',
};

describe('FK_REFS covers the real schema (#152, #246)', () => {
  const syncTables = new Set<string>(SYNC_TABLES);
  let driver: MemoryDriver;
  let schemaFks: SchemaFk[];

  beforeAll(async () => {
    driver = createMemoryDriver();
    await runMigrations(driver, migrations);

    schemaFks = [];
    for (const table of SYNC_TABLES) {
      const fks = await driver.query<ForeignKeyRow>(`PRAGMA foreign_key_list(${table});`);
      if (fks.length === 0) continue;
      const cols = await driver.query<ColumnRow>(`PRAGMA table_info(${table});`);
      const notNullByCol = new Map(cols.map((c) => [c.name, c.notnull === 1]));
      for (const fk of fks) {
        if (!syncTables.has(fk.table)) continue; // parent is not snapshot-resolved
        schemaFks.push({
          table,
          col: fk.from,
          parent: fk.table as SyncTable,
          onDelete: fk.on_delete,
          notNull: notNullByCol.get(fk.from) ?? false,
        });
      }
    }
  });

  afterAll(async () => {
    await driver.close();
  });

  it('finds the references it is meant to be checking (the enumeration works)', () => {
    // Guards against the whole suite passing because the pragmas returned nothing.
    expect(schemaFks.length).toBeGreaterThan(30);
    const rel = schemaFks.filter((f) => f.table === 'item_relations').map((f) => f.col);
    expect(rel).toEqual(expect.arrayContaining(['from_item_id', 'to_item_id']));
    // The nullable-but-CASCADE column that makes the naive `!notnull` rule wrong.
    const contact = schemaFks.find((f) => f.table === 'checkouts' && f.col === 'contact_id');
    expect(contact).toMatchObject({ onDelete: 'CASCADE', notNull: false });
  });

  it('declares every synced→synced reference with the correct nullable flag', () => {
    const problems: string[] = [];
    for (const fk of schemaFks) {
      const key = `${fk.table}.${fk.col}`;
      if (key in EXEMPT) continue;
      const entry = FK_REFS[fk.table]?.find((ref) => ref.col === fk.col && ref.parent === fk.parent);
      if (!entry) {
        problems.push(`${key} → ${fk.parent}: missing from FK_REFS`);
        continue;
      }
      const want = expectedNullable(fk);
      if (entry.nullable !== want) {
        problems.push(
          `${key} → ${fk.parent}: nullable is ${entry.nullable} but the schema ` +
            `(NOT NULL=${fk.notNull}, ON DELETE ${fk.onDelete}) requires ${want}`,
        );
      }
    }
    expect(problems).toEqual([]);
  });

  it('carries no stale entry the schema no longer declares', () => {
    const declared = new Set(schemaFks.map((f) => `${f.table}.${f.col}→${f.parent}`));
    const stale: string[] = [];
    for (const [table, refs] of Object.entries(FK_REFS)) {
      for (const ref of refs ?? []) {
        const entryKey = `${table}.${ref.col}→${ref.parent}`;
        if (!declared.has(entryKey)) stale.push(entryKey);
      }
    }
    expect(stale).toEqual([]);
  });

  it('keeps the EXEMPT list free of stale entries', () => {
    // An exemption for a reference the schema no longer declares would silently license a gap.
    const declared = new Set(schemaFks.map((f) => `${f.table}.${f.col}`));
    const stale = Object.keys(EXEMPT).filter((key) => !declared.has(key));
    expect(stale).toEqual([]);
  });
});
