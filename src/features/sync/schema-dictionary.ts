/**
 * Schema-dictionary payload sanitisation (spec §7.3 step 2, Phase 7).
 *
 * To prevent "Version Mismatch" crashes — a peer on an older schema receiving a row
 * with a column it does not have — the engine strips any key from an incoming remote
 * row that is not in the local table's current column set *before* preparing the
 * UPSERT. {@link buildSchemaDictionary} reads the live column set from the database
 * (so it can never drift from the real schema); {@link sanitiseRow} is pure.
 */
import { SYNC_EXCLUDED_COLUMNS } from '@/db/repositories';
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

/**
 * Read the live column names of each syncable table into a dictionary (§7.3). Accepts
 * any table name (not just {@link SyncTable}) so the engine can also sanitise the
 * non-LWW `item_history` ledger rows it unions in (Phase 11).
 */
export async function buildSchemaDictionary(
  driver: IDatabaseDriver,
  tables: readonly string[],
): Promise<SchemaDictionary> {
  const dictionary: Record<string, readonly string[]> = {};
  for (const table of tables) {
    const cols = await driver.query<{ name: string }>(`PRAGMA table_info(${table});`);
    // Drop columns held back from sync (§7.6.3-B: item_images.full_res_downgraded_at is
    // per-device OPFS state, never propagated). Stripping here means the engine neither
    // applies an incoming value nor includes the column in any UPSERT it builds.
    const excluded = new Set(SYNC_EXCLUDED_COLUMNS[table as SyncTable] ?? []);
    dictionary[table] = cols.map((c) => c.name).filter((name) => !excluded.has(name));
  }
  return dictionary;
}
