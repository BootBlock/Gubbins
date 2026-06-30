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
 * with the §7.5-style alias-text collision resolved in the reconcile engine.
 * `maintenance_schedules` (the §4.3 Tool Maintenance primitive) joined in Phase 9 —
 * it is a scalar-column, LWW-simple table carrying its own `updated_at`.
 *
 * Phase 11 ("sync-set expansion") brought in the remaining LWW leaf/definition tables
 * so a backup/restore/sync is genuinely whole: `category_fields` + `item_field_values`
 * (the §4 dynamic-schema EAV), `tags` (the dictionary), `item_images` (§4.2 — thumbnail
 * BLOB base64-encoded into the payload, full-res OPFS bytes stay local), `item_attachments`
 * (datasheet pointers), and `projects` + `project_bom_lines`. They all carry an
 * `updated_at` + auto-stamp trigger, so they resolve by the same row-level LWW.
 *
 * The two tables WITHOUT an `updated_at` are deliberately *not* in this list — they are
 * reconciled by bespoke rules in the engine and read/written as dedicated snapshot
 * sections (see {@link ITEM_TAGS_TABLE} / {@link ITEM_HISTORY_TABLE}): the M:N
 * `item_tags` join resolves by **membership** (union minus {@link itemTagEdgeId} edge
 * tombstones), and the immutable `item_history` ledger by **union-by-id** (gated by the
 * §7.6.3-A prune watermark). Both are tombstone/auxiliary, not LWW.
 *
 * Order is dependency-safe (parents before children) so a batch of UPSERTs in this
 * order never trips a foreign key.
 */
export const SYNC_TABLES = [
  'locations',
  'categories',
  'category_fields', // FK → categories
  'tags', // independent dictionary
  'items', // FK → categories
  'supplier_parts', // FK → items (Phase 60 — N suppliers per item; ordered after items so its FK never trips on an UPSERT batch)
  'item_stock', // FK → items, locations (per-location ledger; LWW; ordered after items so its recompute trigger has the final word on items.quantity)
  'stock_batches', // FK → items, locations (per-batch ledger, the SSOT below item_stock; ordered after it so its recompute trigger has the final word on item_stock.quantity → items.quantity)
  'item_aliases', // FK → items
  'item_field_values', // FK → items, category_fields
  'item_images', // FK → items
  'item_attachments', // FK → items
  'capabilities',
  'contacts',
  'checkouts',
  'projects', // independent
  'project_bom_lines', // FK → projects, items
  'project_budget_categories', // FK → projects (ordered before project_expenses, its parent)
  'project_expenses', // FK → projects, project_budget_categories
  'maintenance_schedules', // FK → items
  'purchase_orders', // independent (supplier-keyed order; Phase 62 — ordered after items/supplier_parts so its child's FKs never trip on an UPSERT batch)
  'purchase_order_lines', // FK → purchase_orders (CASCADE), items + supplier_parts (SET NULL) — ordered after its parent PO and after items/supplier_parts (Phase 62)
] as const;

export type SyncTable = (typeof SYNC_TABLES)[number];

/**
 * The M:N `item_tags` join (composite PK `(item_id, tag_id)`, no `id`/`updated_at`).
 * Not in {@link SYNC_TABLES} — it has no row-level timestamp, so it cannot resolve by
 * LWW. The engine resolves it by **membership** (Phase 11): an edge is present unless a
 * deletion tombstone exists on either side (a tombstone-wins union / 2P-set), so an
 * unlink propagates and a re-add becomes possible only once the edge tombstone is
 * TTL-pruned. Its tombstones reuse the `tombstones` table keyed by {@link itemTagEdgeId}.
 */
export const ITEM_TAGS_TABLE = 'item_tags';

/**
 * The append-only `item_history` Activity Ledger (immutable, no `updated_at`). Not in
 * {@link SYNC_TABLES} — it reconciles by **union-by-id** (Phase 11): the same immutable
 * event has the same UUID on every device, so a row is simply inserted where missing.
 * The §7.6.3-A local prune watermark (`sync_meta.history_pruned_before`) keeps a device
 * that deliberately pruned old history from re-importing it.
 */
export const ITEM_HISTORY_TABLE = 'item_history';

/**
 * Separator for an `item_tags` edge tombstone id. A UUID is hex + hyphens, so `|` can
 * never appear inside one, making `${itemId}|${tagId}` an unambiguous composite key.
 */
const EDGE_SEP = '|';

/** Composite tombstone id for an `item_tags` edge (membership deletion, §7.3/Phase 11). */
export function itemTagEdgeId(itemId: string, tagId: string): string {
  return `${itemId}${EDGE_SEP}${tagId}`;
}

/** Split an {@link itemTagEdgeId} back into its `(itemId, tagId)` pair. */
export function parseItemTagEdgeId(id: string): { itemId: string; tagId: string } {
  const sep = id.indexOf(EDGE_SEP);
  return { itemId: id.slice(0, sep), tagId: id.slice(sep + 1) };
}

/** The INSERT-OR-REPLACE recording an `item_tags` edge deletion as a tombstone. */
export function itemTagTombstoneStatement(itemId: string, tagId: string): SqlStatement {
  return {
    sql: 'INSERT OR REPLACE INTO tombstones (table_name, id) VALUES (?, ?);',
    params: [ITEM_TAGS_TABLE, itemTagEdgeId(itemId, tagId)],
  };
}

/** Clear any stale `item_tags` edge tombstone (run when an edge is re-linked locally). */
export function clearItemTagTombstoneStatement(itemId: string, tagId: string): SqlStatement {
  return {
    sql: 'DELETE FROM tombstones WHERE table_name = ? AND id = ?;',
    params: [ITEM_TAGS_TABLE, itemTagEdgeId(itemId, tagId)],
  };
}

/**
 * Columns excluded from the synced payload even though they exist on the local schema
 * (§7.6.3-B). `item_images.full_res_downgraded_at` is *per-device* OPFS state — it marks
 * that a device dropped its own local full-res file (Phase 10). Propagating it would make
 * a peer that still holds its full-res image wrongly believe it was downgraded, so the
 * schema dictionary and the snapshot reader both strip it.
 */
export const SYNC_EXCLUDED_COLUMNS: Partial<Record<SyncTable, readonly string[]>> = {
  item_images: ['full_res_downgraded_at'],
};

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
