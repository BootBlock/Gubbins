/**
 * StorageRepository — OPFS Quota Recovery read/prune primitives (spec §7.6.2, §7.6.3).
 *
 * Feeds the Storage Triage Dashboard. Two responsibilities:
 *  - §7.6.2 estimate: cheap `COUNT(*)`s for the three OPFS-dominant tables, which the
 *    pure `estimateTableBytes` maths turn into a byte breakdown (SQLite WASM cannot
 *    cheaply measure true table sizes, so consumption is row-count × avg-byte).
 *  - §7.6.3 recovery workflows: read the targeted rows (so the caller can write the
 *    "cold storage" JSON archive first), then prune history / mark images downgraded.
 *
 * Recovery writes deliberately **bypass the storage Hard Stop**: the whole point of
 * §7.6 is to let a locked-out user reclaim space, so a DELETE (history prune) and the
 * space-freeing downgrade UPDATE must succeed even at the locked tier. The image
 * downgrade is **local-only** and never propagates to cloud sync (§7.6.3 B) — it just
 * stamps `full_res_downgraded_at`; `item_images` is not in `SYNC_TABLES`.
 */
import { BaseRepository } from './base';
import { rowToHistoryEntry } from './mappers';
import type {
  DowngradableImage,
  ItemHistoryEntry,
  ItemHistoryRow,
  Page,
  PageParams,
  StorageRowCounts,
} from './types';

export class StorageRepository extends BaseRepository {
  /** Row counts for the three OPFS-dominant tables (§7.6.2). */
  async rowCounts(): Promise<StorageRowCounts> {
    const [items, itemHistory, itemImages] = await Promise.all([
      this.count('items'),
      this.count('item_history'),
      this.count('item_images'),
    ]);
    return { items, itemHistory, itemImages };
  }

  private async count(table: string): Promise<number> {
    const row = await this.driver.queryOne<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table};`);
    return Number(row?.n ?? 0);
  }

  // --- Workflow A: Action History Pruning (§7.6.3) ------------------------------

  /** How many history rows are older than `cutoff` (strictly before). */
  async countHistoryBefore(cutoff: number): Promise<number> {
    const row = await this.driver.queryOne<{ n: number }>(
      'SELECT COUNT(*) AS n FROM item_history WHERE created_at < ?;',
      [cutoff],
    );
    return Number(row?.n ?? 0);
  }

  /**
   * A page of the history rows that would be pruned, oldest first — looped to
   * completion by the caller to build the cold-storage JSON archive *before* the
   * delete (the §7.6.3 audit-trail safeguard).
   */
  async listHistoryBefore(cutoff: number, params: PageParams = {}): Promise<Page<ItemHistoryEntry>> {
    const { limit, offset } = this.resolvePage(params);
    const rows = await this.driver.query<ItemHistoryRow>(
      `SELECT * FROM item_history WHERE created_at < ?
       ORDER BY created_at ASC, rowid ASC
       LIMIT ? OFFSET ?;`,
      [cutoff, limit, offset],
    );
    return this.toPage(rows.map(rowToHistoryEntry), limit, offset);
  }

  /**
   * Prune (DELETE) history older than `cutoff`, returning the number removed. A
   * DELETE frees space, so it is permitted under the Hard Stop. The caller MUST have
   * already downloaded the cold-storage archive (§7.6.3 safeguard).
   *
   * Also advances the §7.6.3-A sync prune watermark monotonically: once the ledger
   * joined `SYNC_TABLES` (Phase 11) it reconciles by union-by-id, so without this a
   * peer that still holds the pruned rows would simply re-download them on the next
   * sync, silently undoing the reclamation. The reconcile engine refuses to import any
   * remote history row older than `history_pruned_before`.
   */
  async pruneHistoryBefore(cutoff: number): Promise<number> {
    const result = await this.driver.execute('DELETE FROM item_history WHERE created_at < ?;', [
      cutoff,
    ]);
    await this.driver.execute(
      'UPDATE sync_meta SET history_pruned_before = MAX(history_pruned_before, ?) WHERE id = 1;',
      [cutoff],
    );
    return result.rowsModified;
  }

  // --- Workflow B: Image Downgrading (§7.6.3) -----------------------------------

  /** How many images created before `cutoff` still hold a full-resolution file. */
  async countDowngradableBefore(cutoff: number): Promise<number> {
    const row = await this.driver.queryOne<{ n: number }>(
      'SELECT COUNT(*) AS n FROM item_images WHERE created_at < ? AND full_res_downgraded_at IS NULL;',
      [cutoff],
    );
    return Number(row?.n ?? 0);
  }

  /**
   * A page of images whose full-resolution OPFS file can be dropped (oldest first):
   * created before `cutoff` and not already downgraded. The caller deletes each raw
   * OPFS file, then calls {@link markImageDowngraded}.
   */
  async listDowngradableBefore(
    cutoff: number,
    params: PageParams = {},
  ): Promise<Page<DowngradableImage>> {
    const { limit, offset } = this.resolvePage(params);
    const rows = await this.driver.query<{ id: string; full_res_opfs_path: string }>(
      `SELECT id, full_res_opfs_path FROM item_images
       WHERE created_at < ? AND full_res_downgraded_at IS NULL
       ORDER BY created_at ASC, rowid ASC
       LIMIT ? OFFSET ?;`,
      [cutoff, limit, offset],
    );
    return this.toPage(
      rows.map((r) => ({ id: r.id, fullResOpfsPath: r.full_res_opfs_path })),
      limit,
      offset,
    );
  }

  /**
   * Record that an image's full-resolution file was dropped, keeping its thumbnail.
   * An UPDATE, but it *reclaims* space, so it deliberately bypasses the Hard Stop —
   * blocking it would trap the very locked-out user §7.6 exists to rescue. Local-only:
   * never propagated to cloud sync (§7.6.3 B).
   */
  async markImageDowngraded(id: string, at: number = Date.now()): Promise<void> {
    await this.driver.execute('UPDATE item_images SET full_res_downgraded_at = ? WHERE id = ?;', [
      at,
      id,
    ]);
  }
}
