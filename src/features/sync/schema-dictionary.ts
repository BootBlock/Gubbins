/**
 * Schema-dictionary payload sanitisation (spec §7.3 step 2, Phase 7).
 *
 * To prevent "Version Mismatch" crashes — a peer on an older schema receiving a row
 * with a column it does not have — the engine strips any key from an incoming remote
 * row that is not in the local table's current column set *before* preparing the
 * UPSERT. {@link buildSchemaDictionary} reads the live column set from the database
 * (so it can never drift from the real schema); {@link sanitiseRow} is pure.
 */
import type { IDatabaseDriver, SqlRow } from '@/db/rpc/driver';
import type { SchemaDictionary, SyncTable } from './types';

/** Strip every key not present in `allowed`, returning a new row (pure). */
export function sanitiseRow(row: SqlRow, allowed: readonly string[]): SqlRow {
  const allowedSet = new Set(allowed);
  const clean: SqlRow = {};
  for (const [key, value] of Object.entries(row)) {
    if (allowedSet.has(key)) clean[key] = value;
  }
  return clean;
}

/** Read the live column names of each syncable table into a dictionary (§7.3). */
export async function buildSchemaDictionary(
  driver: IDatabaseDriver,
  tables: readonly SyncTable[],
): Promise<SchemaDictionary> {
  const dictionary: Record<string, readonly string[]> = {};
  for (const table of tables) {
    const cols = await driver.query<{ name: string }>(`PRAGMA table_info(${table});`);
    dictionary[table] = cols.map((c) => c.name);
  }
  return dictionary;
}
