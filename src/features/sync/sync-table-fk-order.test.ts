/**
 * Drift guard (issue #535). {@link SYNC_TABLES} documents itself as dependency-safe — parents
 * before children, so a batch of UPSERTs walked in index order never presents a child ahead of
 * the row it references — and three apply paths take that at its word: `applyPlan` sorts its
 * upserts by the index, `buildCloneStatements` emits table by table (after wiping in the reverse
 * order), and `restoreSnapshot` walks it directly.
 *
 * Nothing checked it. `checkouts` sat two entries *before* `projects` even though a loan can be
 * taken out against a project, so a database holding one could not be cloned or Replace-restored:
 * the loan was written while `projects` was still empty. The list is hand-maintained and its
 * ordering rationale lives in end-of-line comments, which is exactly the shape of contract that
 * rots the next time a table is added.
 *
 * So derive it from the schema rather than the comments: read `PRAGMA foreign_key_list` over the
 * built database and assert every synced child's synced parent sits at a strictly smaller index.
 *
 * Two shapes are deliberately not violations:
 *  - a **self**-reference (`locations.parent_id`, `items.parent_id`). A table is neither before
 *    nor after itself, so no ordering of this list can express it; the apply paths run under
 *    `PRAGMA defer_foreign_keys = ON` for that (issue #602).
 *  - a parent **outside** the synced set. It is not written by these batches at all, so the index
 *    says nothing about it. The test still reports these, because a synced table referencing an
 *    unsynced parent is worth seeing rather than silently skipping.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createMemoryDriver, type MemoryDriver } from '@/test/drivers/memory-driver';
import { runMigrations } from '@/db/migrations/engine';
import { migrations } from '@/db/migrations';
import { SYNC_TABLES, type SyncTable } from '@/db/repositories';

/** A row of `PRAGMA foreign_key_list(<table>)`. */
interface ForeignKeyRow {
  readonly from: string; // the child column
  readonly table: string; // the parent table
}

/** One foreign key declared by a synced table. */
interface SchemaFk {
  readonly table: SyncTable;
  readonly col: string;
  readonly parent: string;
}

describe('SYNC_TABLES is dependency-safe against the real schema (#535)', () => {
  const indexOf = new Map<string, number>(SYNC_TABLES.map((t, i) => [t, i]));
  let driver: MemoryDriver;
  let schemaFks: SchemaFk[];

  beforeAll(async () => {
    driver = createMemoryDriver();
    await runMigrations(driver, migrations);

    schemaFks = [];
    for (const table of SYNC_TABLES) {
      const fks = await driver.query<ForeignKeyRow>(`PRAGMA foreign_key_list(${table});`);
      for (const fk of fks) {
        schemaFks.push({ table, col: fk.from, parent: fk.table });
      }
    }
  });

  afterAll(async () => {
    await driver.close();
  });

  it('finds the references it is meant to be checking (the enumeration works)', () => {
    // Guards against the whole suite passing because the pragma returned nothing.
    expect(schemaFks.length).toBeGreaterThan(30);
    // The reference issue #535 was about, and the self-reference the ordering cannot cover.
    expect(schemaFks).toContainEqual({ table: 'checkouts', col: 'project_id', parent: 'projects' });
    expect(schemaFks).toContainEqual({ table: 'locations', col: 'parent_id', parent: 'locations' });
  });

  it('lists every synced parent before every table that references it', () => {
    const violations = schemaFks
      .filter((fk) => fk.parent !== fk.table && indexOf.has(fk.parent))
      .filter((fk) => indexOf.get(fk.parent)! > indexOf.get(fk.table)!)
      .map(
        (fk) =>
          `${fk.table}.${fk.col} → ${fk.parent} (child at ${indexOf.get(fk.table)}, parent at ${indexOf.get(fk.parent)})`,
      );

    // Reported as data so a failure names the offending reference, not just a count.
    expect(violations).toEqual([]);
  });

  it('references no parent outside the synced set', () => {
    // A synced row whose parent is never written by these batches cannot be made safe by
    // ordering at all — it would need the parent to be synced, or the reference to be repaired.
    const outside = schemaFks
      .filter((fk) => !indexOf.has(fk.parent))
      .map((fk) => `${fk.table}.${fk.col} → ${fk.parent}`);

    expect(outside).toEqual([]);
  });

  it('names each table exactly once, so an index is unambiguous', () => {
    // Two entries for one table would give `indexOf` one of them and the apply paths' `indexOf`
    // the other, quietly breaking the ordering the tests above rely on.
    expect(indexOf.size).toBe(SYNC_TABLES.length);
  });
});
