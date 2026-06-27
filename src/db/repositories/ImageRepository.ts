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
import type { CreateImageInput, ItemImage, ItemImageRow } from './types';

export class ImageRepository extends BaseRepository {
  /** All image metadata for an item (bounded per item), ordered by position. */
  async listForItem(itemId: string): Promise<ItemImage[]> {
    const rows = await this.driver.query<ItemImageRow>(
      `SELECT * FROM item_images WHERE item_id = ?
       ORDER BY position ASC, created_at ASC;`,
      [itemId],
    );
    return rows.map(rowToItemImage);
  }

  /** Insert one image record. Write-gated (it grows storage). */
  async add(input: CreateImageInput): Promise<ItemImage> {
    this.assertWritable();
    const path = input.fullResOpfsPath.trim();
    if (path.length === 0) {
      throw new DbError('SQLITE_CONSTRAINT', 'An image requires an OPFS path.');
    }
    const id = crypto.randomUUID();
    await this.driver.execute(
      `INSERT INTO item_images (id, item_id, thumbnail_blob, full_res_opfs_path, position)
       VALUES (?, ?, ?, ?, ?);`,
      [id, input.itemId, input.thumbnailBlob, path, input.position ?? 0],
    );
    const row = await this.driver.queryOne<ItemImageRow>('SELECT * FROM item_images WHERE id = ?;', [
      id,
    ]);
    return rowToItemImage(row!);
  }

  /**
   * Delete an image record, returning its OPFS path so the caller can purge the
   * raw file from the file system. Permitted under the Hard Stop (frees space).
   */
  async remove(id: string): Promise<string | undefined> {
    const row = await this.driver.queryOne<{ full_res_opfs_path: string }>(
      'SELECT full_res_opfs_path FROM item_images WHERE id = ?;',
      [id],
    );
    if (!row) return undefined;
    await this.driver.execute('DELETE FROM item_images WHERE id = ?;', [id]);
    return row.full_res_opfs_path;
  }
}
