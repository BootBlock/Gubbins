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
  DowngradableOwner,
} from './types';

export class StorageRepository extends BaseRepository {
  /**
   * Row counts for the OPFS-dominant tables (§7.6.2). Photos are counted across *both*
   * owning tables: item images and location photos share the OPFS `images/` directory and
   * the same row shape, so counting only one would under-report consumption (issue #81).
   */
  async rowCounts(): Promise<StorageRowCounts> {
    const [items, itemHistory, itemImages, locationPhotos] = await Promise.all([
      this.count('items'),
      this.count('item_history'),
      this.count('item_images'),
      this.count('location_photos'),
    ]);
    return { items, itemHistory, photos: itemImages + locationPhotos };
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
    this.assertPermission('audit:delete');
    const result = await this.driver.execute('DELETE FROM item_history WHERE created_at < ?;', [cutoff]);
    await this.driver.execute(
      'UPDATE sync_meta SET history_pruned_before = MAX(history_pruned_before, ?) WHERE id = 1;',
      [cutoff],
    );
    return result.rowsModified;
  }

  // --- Workflow B: Image Downgrading (§7.6.3) -----------------------------------

  /** How many photos created before `cutoff` still hold a full-resolution file. */
  async countDowngradableBefore(cutoff: number): Promise<number> {
    const row = await this.driver.queryOne<{ n: number }>(
      `SELECT (SELECT COUNT(*) FROM item_images
                WHERE created_at < ?1 AND full_res_downgraded_at IS NULL)
            + (SELECT COUNT(*) FROM location_photos
                WHERE created_at < ?1 AND full_res_downgraded_at IS NULL) AS n;`,
      [cutoff],
    );
    return Number(row?.n ?? 0);
  }

  /**
   * A page of photos whose full-resolution OPFS file can be dropped (oldest first):
   * created before `cutoff` and not already downgraded. The caller deletes each raw OPFS
   * file, then calls {@link markImageDowngraded} with the row's `owner`.
   *
   * Spans both owning tables so triage frees the largest files first regardless of whether
   * they belong to an item or a location — ordering by age across the union, not per table.
   */
  async listDowngradableBefore(cutoff: number, params: PageParams = {}): Promise<Page<DowngradableImage>> {
    const { limit, offset } = this.resolvePage(params);
    const rows = await this.driver.query<{
      id: string;
      full_res_opfs_path: string;
      owner: DowngradableOwner;
    }>(
      `SELECT id, full_res_opfs_path, 'item_images' AS owner, created_at FROM item_images
        WHERE created_at < ?1 AND full_res_downgraded_at IS NULL
       UNION ALL
       SELECT id, full_res_opfs_path, 'location_photos' AS owner, created_at FROM location_photos
        WHERE created_at < ?1 AND full_res_downgraded_at IS NULL
       ORDER BY created_at ASC, id ASC
       LIMIT ?2 OFFSET ?3;`,
      [cutoff, limit, offset],
    );
    return this.toPage(
      rows.map((r) => ({ id: r.id, fullResOpfsPath: r.full_res_opfs_path, owner: r.owner })),
      limit,
      offset,
    );
  }

  /**
   * Record that a photo's full-resolution file was dropped, keeping its thumbnail.
   *
   * `owner` is required rather than defaulted: the id and the table must agree, and a default
   * would let a forgotten argument update the wrong table, match no row, and report success —
   * leaving a deleted file with no row marked downgraded.
   *
   * An UPDATE, but it *reclaims* space, so it deliberately bypasses the Hard Stop —
   * blocking it would trap the very locked-out user §7.6 exists to rescue. Local-only:
   * never propagated to cloud sync (§7.6.3 B).
   *
   * Unguarded by a permission check on purpose: this is internal storage housekeeping the app
   * runs on its own behalf, not a user action anyone chooses to perform (issue #79, §2.3).
   */
  async markImageDowngraded(id: string, owner: DowngradableOwner, at: number = Date.now()): Promise<void> {
    // `owner` comes from the closed DowngradableOwner union, never from user input, so it is
    // safe to interpolate as a table name — the driver cannot bind an identifier.
    await this.driver.execute(`UPDATE ${owner} SET full_res_downgraded_at = ? WHERE id = ?;`, [at, id]);
  }
}
