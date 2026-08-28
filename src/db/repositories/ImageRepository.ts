/**
 * ImageRepository (spec §2.1.1, §4.2).
 *
 * Stores only the lightweight image *metadata* (spec §4.2.2): a tiny
 * `thumbnail_blob` for list rendering and the `full_res_opfs_path` pointer to the
 * raw WebP file in OPFS. The **Anti-Base64 Directive (§4.2.1)** is absolute — the
 * full-resolution bytes never enter the database; the canvas→WebP→OPFS pipeline in
 * the UI layer writes them as a raw OPFS file and passes only the path here. On
 * removal we hand the OPFS path back so the caller can delete the orphaned file.
 */
import { DbError } from '../errors';
import { BaseRepository } from './base';
import { rowToItemImage } from './mappers';
import { tombstoneStatement } from './tombstone';
import type { CreateImageInput, ItemImage, ItemImageRow } from './types';

/**
 * The order an item's images are returned in, written once so the single-item read and the
 * batched one cannot come to disagree about it. The batched read only prefixes `item_id` to
 * group its rows; everything that decides the order *within* an item is this.
 */
const ITEM_IMAGE_ORDER = 'position ASC, created_at ASC';

export class ImageRepository extends BaseRepository {
  /** All image metadata for an item (bounded per item), ordered by position. */
  async listForItem(itemId: string): Promise<ItemImage[]> {
    const rows = await this.driver.query<ItemImageRow>(
      `SELECT * FROM item_images WHERE item_id = ?
       ORDER BY ${ITEM_IMAGE_ORDER};`,
      [itemId],
    );
    return rows.map(rowToItemImage);
  }

  /**
   * Image metadata for a **set** of items, keyed by item id (issue #527) — the batch companion
   * to {@link listForItem}, so the Markdown-vault export reads one query per bucket of items
   * instead of one per item. An item with no images is simply absent from the map; an empty
   * input queries nothing.
   */
  async listForItems(itemIds: readonly string[]): Promise<Map<string, ItemImage[]>> {
    const byItem = new Map<string, ItemImage[]>();
    const unique = [...new Set(itemIds)];
    if (unique.length === 0) return byItem;
    const rows = await this.driver.query<ItemImageRow>(
      `SELECT * FROM item_images WHERE item_id IN (${unique.map(() => '?').join(', ')})
       ORDER BY item_id, ${ITEM_IMAGE_ORDER};`,
      unique,
    );
    for (const row of rows) {
      const image = rowToItemImage(row);
      const list = byItem.get(image.itemId);
      if (list) list.push(image);
      else byItem.set(image.itemId, [image]);
    }
    return byItem;
  }

  /** Insert one image record. Write-gated (it grows storage). */
  async add(input: CreateImageInput): Promise<ItemImage> {
    this.assertPermission('items:write');
    this.assertWritable();
    const path = input.fullResOpfsPath.trim();
    if (path.length === 0) {
      throw new DbError('SQLITE_CONSTRAINT', 'An image requires an OPFS path.');
    }
    const id = crypto.randomUUID();
    await this.driver.execute(
      `INSERT INTO item_images
         (id, item_id, thumbnail_blob, full_res_opfs_path, full_res_downgraded_at, position)
       VALUES (?, ?, ?, ?, ?, ?);`,
      [id, input.itemId, input.thumbnailBlob, path, input.fullResDowngradedAt ?? null, input.position ?? 0],
    );
    const row = await this.driver.queryOne<ItemImageRow>('SELECT * FROM item_images WHERE id = ?;', [id]);
    return rowToItemImage(row!);
  }

  /**
   * Delete an image record, returning its OPFS path so the caller can purge the
   * raw file from the file system. Permitted under the Hard Stop (frees space).
   */
  async remove(id: string): Promise<string | undefined> {
    this.assertPermission('items:write');
    const row = await this.driver.queryOne<{ full_res_opfs_path: string }>(
      'SELECT full_res_opfs_path FROM item_images WHERE id = ?;',
      [id],
    );
    if (!row) return undefined;
    // Tombstone the deletion in the same transaction so it propagates on the next sync
    // (item_images joined SYNC_TABLES in Phase 11) rather than re-downloading from a peer.
    await this.driver.transaction([
      { sql: 'DELETE FROM item_images WHERE id = ?;', params: [id] },
      tombstoneStatement('item_images', id),
    ]);
    return row.full_res_opfs_path;
  }
}
