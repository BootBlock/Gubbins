/**
 * AttachmentRepository (spec §2.1.1, §4 "Attachments & Datasheets").
 *
 * Manages an item's datasheet links: external `URL`s and `LOCAL_POINTER` path
 * strings. Per the Strict Sync Isolation rule (§4) a local pointer stores only the
 * literal file path — never the blob — so it is safe to synchronise. Which kinds a
 * user may add is governed by the `attachmentMode` preference (Option A: URLs only,
 * Option B: Hybrid Pointers); this layer accepts either kind.
 */
import { DbError } from '../errors';
import { BaseRepository } from './base';
import { rowToItemAttachment } from './mappers';
import type { CreateAttachmentInput, ItemAttachment, ItemAttachmentRow } from './types';

export interface UpdateAttachmentInput {
  readonly value?: string;
  readonly label?: string | null;
  readonly position?: number;
}

export class AttachmentRepository extends BaseRepository {
  async listForItem(itemId: string): Promise<ItemAttachment[]> {
    const rows = await this.driver.query<ItemAttachmentRow>(
      `SELECT * FROM item_attachments WHERE item_id = ?
       ORDER BY position ASC, created_at ASC;`,
      [itemId],
    );
    return rows.map(rowToItemAttachment);
  }

  async add(input: CreateAttachmentInput): Promise<ItemAttachment> {
    this.assertWritable();
    const value = this.validateValue(input.kind, input.value);
    const id = crypto.randomUUID();
    await this.driver.execute(
      `INSERT INTO item_attachments (id, item_id, kind, value, label, position)
       VALUES (?, ?, ?, ?, ?, ?);`,
      [id, input.itemId, input.kind, value, input.label ?? null, input.position ?? 0],
    );
    return (await this.requireById(id));
  }

  async update(id: string, input: UpdateAttachmentInput): Promise<ItemAttachment> {
    this.assertWritable();
    const existing = await this.requireById(id);

    const sets: string[] = [];
    const params: (string | number | null)[] = [];
    if (input.value !== undefined) {
      sets.push('value = ?');
      params.push(this.validateValue(existing.kind, input.value));
    }
    if (input.label !== undefined) {
      sets.push('label = ?');
      params.push(input.label);
    }
    if (input.position !== undefined) {
      sets.push('position = ?');
      params.push(input.position);
    }
    if (sets.length > 0) {
      params.push(id);
      await this.driver.execute(
        `UPDATE item_attachments SET ${sets.join(', ')} WHERE id = ?;`,
        params,
      );
    }
    return this.requireById(id);
  }

  /** Delete an attachment record. Permitted under the Hard Stop (frees space). */
  async remove(id: string): Promise<void> {
    await this.driver.execute('DELETE FROM item_attachments WHERE id = ?;', [id]);
  }

  // --- internals -----------------------------------------------------------------

  private async requireById(id: string): Promise<ItemAttachment> {
    const row = await this.driver.queryOne<ItemAttachmentRow>(
      'SELECT * FROM item_attachments WHERE id = ?;',
      [id],
    );
    if (!row) {
      throw new DbError('SQLITE_CONSTRAINT', `Attachment "${id}" does not exist.`);
    }
    return rowToItemAttachment(row);
  }

  /** Trim and validate the link value; URLs must be parseable http(s) links. */
  private validateValue(kind: string, raw: string): string {
    const value = raw.trim();
    if (value.length === 0) {
      throw new DbError('SQLITE_CONSTRAINT', 'An attachment requires a value.');
    }
    if (kind === 'URL') {
      let url: URL;
      try {
        url = new URL(value);
      } catch {
        throw new DbError('SQLITE_CONSTRAINT', 'Enter a valid URL (http or https).');
      }
      if (url.protocol !== 'http:' && url.protocol !== 'https:') {
        throw new DbError('SQLITE_CONSTRAINT', 'Datasheet URLs must use http or https.');
      }
    }
    return value;
  }
}
