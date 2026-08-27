import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createMemoryDriver, type MemoryDriver } from '@/test/drivers/memory-driver';
import { runMigrations } from '@/db/migrations/engine';
import { migrations } from '@/db/migrations';
import { SYNC_TABLES, type SyncTable } from '@/db/repositories';
import { FK_REFS } from './fk-refs';
import { REMOVED_PARENT_TABLES, reconcile } from './reconcile';
import type { SyncSnapshot } from './types';

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
  // NOT NULL `ON DELETE SET DEFAULT` (issue #691), so the rule above would demand `false` —
  // "drop the row". That is the wrong repair for a ledger: an activity entry must not be destroyed
  // because the account that wrote it was removed on another device. Its repair is the schema's
  // own, re-attribution to System, which `FK_REFS` has no way to express and the snapshot repair
  // applies at the source (`snapshot-integrity.ts`, EXTRA_REFS). Exactly how `item_history`'s
  // identical actor column is handled — that ledger simply isn't enumerated here, because it is
  // not a SYNC_TABLES member.
  'location_history.actor_user_id': 're-attributed to System by the snapshot repair, never dropped',
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

  it('names a parent the merge builds a removed-id set for (#536)', () => {
    // The other half of the registry's contract. `enforceForeignKeys` reads a parent with no
    // removed-id set as "intact", so an entry whose parent `computeRemovedParents` does not
    // produce is dead code: the guard never fires, and the merge re-inserts the orphan it exists
    // to drop — a hard `FOREIGN KEY constraint failed` that rolls the whole atomic apply back and
    // recurs on every retry. `location_photos` and `project_budget_categories` were exactly that.
    const parents = new Set(
      Object.values(FK_REFS)
        .flatMap((refs) => refs ?? [])
        .map((ref) => ref.parent),
    );
    // Non-empty, or the assertion below would be vacuous.
    expect(parents.size).toBeGreaterThan(10);
    const covered = new Set<SyncTable>(REMOVED_PARENT_TABLES);
    expect([...parents].filter((parent) => !covered.has(parent))).toEqual([]);
  });

  it('leaves no removed-parent set that nothing references (#536)', () => {
    // The converse: a table kept in REMOVED_PARENT_TABLES after its last FK_REFS entry went is
    // dead work, and reads as coverage the registry no longer has.
    const parents = new Set(
      Object.values(FK_REFS)
        .flatMap((refs) => refs ?? [])
        .map((ref) => ref.parent),
    );
    expect(REMOVED_PARENT_TABLES.filter((table) => !parents.has(table))).toEqual([]);
  });

  it('folds the cascade into the removed set of a parent that is itself a cascade child (#536)', () => {
    // The class of bug behind #536, closed generically rather than one table at a time. A parent
    // that is *itself* a NOT-NULL / ON DELETE CASCADE child is swept away with no tombstone of
    // its own (§7.2 records only the row the user deleted), so a removed set built from
    // deletes-and-upserts alone reads it as alive and waves its children through. That was true
    // of `location_photos`, `project_budget_categories` *and* `supplier_parts`.
    //
    // Rather than assert how `computeRemovedParents` is written, drive `reconcile` for every such
    // parent the real schema declares: delete the grandparent locally, offer the whole chain from
    // the remote, and require the chain not to be resurrected. A new cascade parent added to
    // FK_REFS is covered the moment the schema declares it.
    const parentTables = new Set<SyncTable>(REMOVED_PARENT_TABLES);
    const chains = schemaFks.filter(
      (fk) =>
        parentTables.has(fk.table) && parentTables.has(fk.parent) && fk.notNull && fk.onDelete === 'CASCADE',
    );
    // Non-empty, or every assertion below is vacuous.
    expect(chains.length).toBeGreaterThanOrEqual(3);

    const problems: string[] = [];
    for (const chain of chains) {
      // Any registered child of the middle table will do — it is the row whose FK would trip.
      const childEntry = Object.entries(FK_REFS)
        .flatMap(([child, refs]) => (refs ?? []).map((ref) => ({ child, ref })))
        .find(({ ref }) => ref.parent === chain.table);
      if (childEntry === undefined) continue; // no child to guard, so nothing to assert
      const { child, ref } = childEntry;

      const empty = {
        formatVersion: 1 as const,
        generatedAt: 0,
        tombstones: [],
        gaugeHistory: [],
        itemTags: [],
        locationTags: [],
        itemRegions: [],
        itemHistory: [],
        stockDeltas: [],
      };
      const local: SyncSnapshot = {
        ...empty,
        tables: {},
        // The grandparent is deleted here; the cascade took the middle row with it, untombstoned.
        tombstones: [{ tableName: chain.parent, id: 'GP', deletedAt: 100 }],
      };
      const remote: SyncSnapshot = {
        ...empty,
        tables: {
          [chain.parent]: [{ id: 'GP', updated_at: 50 }],
          [chain.table]: [{ id: 'MID', [chain.col]: 'GP', updated_at: 50 }],
          [child]: [{ id: 'CHILD', [ref.col]: 'MID', updated_at: 50 }],
        },
      };
      const plan = reconcile(local, remote, {
        offset: 0,
        dictionary: {
          [chain.parent]: ['id', 'updated_at'],
          [chain.table]: ['id', chain.col, 'updated_at'],
          [child]: ['id', ref.col, 'updated_at'],
        },
      });

      const label = `${chain.parent} → ${chain.table} → ${child}.${ref.col}`;
      if (plan.localUpserts.some((u) => u.table === chain.table)) {
        problems.push(`${label}: the cascade-removed ${chain.table} row was resurrected`);
      }
      const childUpsert = plan.localUpserts.find((u) => u.table === child);
      if (ref.nullable) {
        // ON DELETE SET NULL: the row is kept, the dangling reference cleared.
        if (childUpsert === undefined) problems.push(`${label}: the child row was dropped, not cleared`);
        else if (childUpsert.row[ref.col] !== null) {
          problems.push(`${label}: the child kept a reference to a row that will not exist`);
        }
      } else if (childUpsert !== undefined) {
        problems.push(`${label}: the child row was upserted against a parent that will not exist`);
      }
    }
    expect(problems).toEqual([]);
  });

  it('keeps the EXEMPT list free of stale entries', () => {
    // An exemption for a reference the schema no longer declares would silently license a gap.
    const declared = new Set(schemaFks.map((f) => `${f.table}.${f.col}`));
    const stale = Object.keys(EXEMPT).filter((key) => !declared.has(key));
    expect(stale).toEqual([]);
  });
});
