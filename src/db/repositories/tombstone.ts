/**
 * Tombstone recording & the syncable-table dictionary (spec §7.2, §7.3, Phase 7).
 *
 * A hard delete (§7.2) removes a row but must leave a tombstone so the deletion is
 * *propagated* on the next sync rather than mistaken for a row the peer should
 * re-download. {@link tombstoneStatement} yields the INSERT a repository folds into
 * the *same* atomic transaction as its DELETE, so a row and its tombstone are never
 * out of step. {@link TombstoneRepository} reads/prunes them for the sync engine.
 */
import { BaseRepository } from './base';
import type { Page, PageParams } from './types';
import type { SqlStatement } from '../rpc/driver';

/**
 * The user-modifiable tables that participate in synchronisation (§7.1). Order is
 * dependency-safe: parents before children, so applying a batch of UPSERTs in this
 * order never trips a foreign-key constraint. The sync engine's schema dictionary
 * (§7.3 payload sanitisation) is derived from this list.
 *
 * `item_aliases` (the §4 Universal Alias Mapping) joined the set in Phase 8 so the
 * supplier↔item mappings scraping creates propagate across devices; it carries its
 * own `updated_at`, so it resolves by the same row-level LWW as the entity tables,
 * with the §7.5-style alias-text collision resolved in the reconcile engine. The
 * remaining join/leaf tables (`item_tags`, `item_images`, attachments, BOM lines,
 * custom-field values) and the append-only `item_history` ledger are still tracked
 * for a later expansion — see `docs/todo/deferred-features.md`.
 */
export const SYNC_TABLES = [
  'locations',
  'categories',
  'items',
  'item_aliases',
  'capabilities',
  'contacts',
  'checkouts',
] as const;

export type SyncTable = (typeof SYNC_TABLES)[number];

export interface Tombstone {
  readonly tableName: string;
  readonly id: string;
  readonly deletedAt: number;
}

interface TombstoneRow {
  readonly table_name: string;
  readonly id: string;
  readonly deleted_at: number;
}

function rowToTombstone(row: TombstoneRow): Tombstone {
  return { tableName: row.table_name, id: row.id, deletedAt: Number(row.deleted_at) };
}

/**
 * Build the tombstone INSERT for a deleted row, to be batched in the *same*
 * transaction as the DELETE. `INSERT OR REPLACE` so re-deleting a re-created id
 * simply refreshes `deleted_at` (the column defaults to the current time).
 */
export function tombstoneStatement(tableName: SyncTable, id: string): SqlStatement {
  return {
    sql: 'INSERT OR REPLACE INTO tombstones (table_name, id) VALUES (?, ?);',
    params: [tableName, id],
  };
}

export class TombstoneRepository extends BaseRepository {
  /** Record a hard deletion on its own (when not already batched with the DELETE). */
  async record(tableName: SyncTable, id: string): Promise<void> {
    await this.driver.execute(tombstoneStatement(tableName, id).sql, [tableName, id]);
  }

  async has(tableName: string, id: string): Promise<boolean> {
    const row = await this.driver.queryOne(
      'SELECT 1 AS ok FROM tombstones WHERE table_name = ? AND id = ?;',
      [tableName, id],
    );
    return row !== undefined;
  }

  /** Paginated tombstones, newest deletion first. */
  async list(params: PageParams = {}): Promise<Page<Tombstone>> {
    const { limit, offset } = this.resolvePage(params);
    const rows = await this.driver.query<TombstoneRow>(
      'SELECT * FROM tombstones ORDER BY deleted_at DESC LIMIT ? OFFSET ?;',
      [limit, offset],
    );
    return this.toPage(rows.map(rowToTombstone), limit, offset);
  }

  /** Every tombstone recorded at or after `since` (for sync push / pre-wipe salvage). */
  async listSince(since: number): Promise<Tombstone[]> {
    const rows = await this.driver.query<TombstoneRow>(
      'SELECT * FROM tombstones WHERE deleted_at >= ? ORDER BY deleted_at ASC;',
      [since],
    );
    return rows.map(rowToTombstone);
  }

  /** Every tombstone (small table; the sync engine needs the full set to diff). */
  async listAll(): Promise<Tombstone[]> {
    const rows = await this.driver.query<TombstoneRow>(
      'SELECT * FROM tombstones ORDER BY deleted_at ASC;',
    );
    return rows.map(rowToTombstone);
  }

  /**
   * §7.2 TTL prune: delete tombstones older than `cutoff` (e.g. now − 180 days).
   * Returns how many were removed. A DELETE, so it bypasses the storage Hard Stop.
   */
  async pruneOlderThan(cutoff: number): Promise<number> {
    const result = await this.driver.execute('DELETE FROM tombstones WHERE deleted_at < ?;', [
      cutoff,
    ]);
    return result.rowsModified;
  }
}
