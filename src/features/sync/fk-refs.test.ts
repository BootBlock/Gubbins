import { describe, it, expect } from 'vitest';
import { SYNC_TABLES, type SyncTable } from '@/db/repositories';
import { v1Initial } from '@/db/migrations/v1-initial';
import { FK_REFS } from './fk-refs';

/**
 * Drift guard (issue #152). Both the reconciliation engine and the backup codec decide what
 * to do about a dangling reference purely from {@link FK_REFS}; a column the registry does
 * not know about is silently treated as "references nothing", which is how a backup that
 * excludes removed items could ship an `item_relations` row pointing at an item the file no
 * longer contains — and abort the whole restore on a foreign-key violation.
 *
 * So rather than trusting the registry to be maintained by hand, read the real schema: every
 * `REFERENCES <parent>(id)` column declared on a synced table must appear in `FK_REFS`.
 */

/** Column name → parent table, for every FK declared in the baseline's CREATE TABLE bodies. */
function schemaForeignKeys(): Map<string, { col: string; parent: string }[]> {
  const byTable = new Map<string, { col: string; parent: string }[]>();
  const add = (table: string, col: string, parent: string): void => {
    const refs = byTable.get(table) ?? [];
    refs.push({ col, parent });
    byTable.set(table, refs);
  };

  for (const statement of v1Initial.statements) {
    const sql = statement.sql;

    // `ALTER TABLE <t> ADD COLUMN <col> ... REFERENCES <parent>(id)` — e.g. items.parent_id.
    const altered = /ALTER TABLE\s+(\w+)\s+ADD COLUMN\s+(\w+)\b[^;]*?REFERENCES\s+(\w+)\s*\(\s*id\s*\)/i.exec(
      sql,
    );
    if (altered) {
      add(altered[1]!, altered[2]!, altered[3]!);
      continue;
    }

    const created = /CREATE TABLE\s+(?:IF NOT EXISTS\s+)?(\w+)\s*\(([\s\S]*)\)/i.exec(sql);
    if (!created) continue;
    const table = created[1]!;
    for (const line of created[2]!.split('\n')) {
      const column = /^\s*(\w+)\s+\w+[^,]*?REFERENCES\s+(\w+)\s*\(\s*id\s*\)/i.exec(line);
      if (column) add(table, column[1]!, column[2]!);
    }
  }
  return byTable;
}

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
  // only reference `filterSnapshot` can dangle is `item_id`, which is covered above.
  'checkouts.project_id': 'tagged-union borrower; needs its own repair rule',
  'checkouts.location_id': 'tagged-union borrower; needs its own repair rule',
};

describe('FK_REFS covers the real schema', () => {
  const syncTables = new Set<string>(SYNC_TABLES);

  it('knows every reference a synced table makes to another synced table', () => {
    const missing: string[] = [];
    for (const [table, refs] of schemaForeignKeys()) {
      if (!syncTables.has(table)) continue; // not carried in a snapshot at all
      for (const { col, parent } of refs) {
        if (!syncTables.has(parent)) continue; // parent is not snapshot-resolved
        if (`${table}.${col}` in EXEMPT) continue;
        const known = FK_REFS[table as SyncTable]?.some((ref) => ref.col === col && ref.parent === parent);
        if (!known) missing.push(`${table}.${col} → ${parent}`);
      }
    }
    expect(missing).toEqual([]);
  });

  it('finds the references it is meant to be checking (the parser works)', () => {
    const refs = schemaForeignKeys();
    expect(refs.get('item_relations')).toEqual([
      { col: 'from_item_id', parent: 'items' },
      { col: 'to_item_id', parent: 'items' },
    ]);
    expect(refs.get('items')).toContainEqual({ col: 'parent_id', parent: 'items' });
  });
});
