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
import { tombstoneStatement } from './tombstone';
import type { AttachmentKind } from './constants';
import type { CreateAttachmentInput, ItemAttachment, ItemAttachmentRow } from './types';

export interface UpdateAttachmentInput {
  readonly value?: string;
  readonly label?: string | null;
  readonly position?: number;
  /**
   * Switch a pointer's kind — used by the §4 "Unlinked Local File" flow to replace a
   * foreign `LOCAL_POINTER` with an external `URL`. The value is validated against this
   * new kind.
   */
  readonly kind?: AttachmentKind;
  /**
   * Restamp the origin device (§4 degradation): set to this device when re-linking a
   * foreign pointer to a local path, or to `null` when replacing it with a URL.
   */
  readonly originDeviceId?: string | null;
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
    // A URL is valid everywhere, so it carries no origin; only a LOCAL_POINTER is
    // attributed to the device that linked it (§4 degradation, v18).
    const originDeviceId = input.kind === 'LOCAL_POINTER' ? (input.originDeviceId ?? null) : null;
    await this.driver.execute(
      `INSERT INTO item_attachments (id, item_id, kind, value, label, position, origin_device_id)
       VALUES (?, ?, ?, ?, ?, ?, ?);`,
      [id, input.itemId, input.kind, value, input.label ?? null, input.position ?? 0, originDeviceId],
    );
    return (await this.requireById(id));
  }

  async update(id: string, input: UpdateAttachmentInput): Promise<ItemAttachment> {
    this.assertWritable();
    const existing = await this.requireById(id);

    // A kind switch (the §4 replace-with-URL flow) validates the value against the *new*
    // kind; otherwise the existing kind governs validation.
    const effectiveKind = input.kind ?? existing.kind;

    const sets: string[] = [];
    const params: (string | number | null)[] = [];
    if (input.kind !== undefined) {
      sets.push('kind = ?');
      params.push(input.kind);
    }
    if (input.value !== undefined) {
      sets.push('value = ?');
      params.push(this.validateValue(effectiveKind, input.value));
    }
    if (input.label !== undefined) {
      sets.push('label = ?');
      params.push(input.label);
    }
    if (input.position !== undefined) {
      sets.push('position = ?');
      params.push(input.position);
    }
    if (input.originDeviceId !== undefined) {
      sets.push('origin_device_id = ?');
      params.push(input.originDeviceId);
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
    // Tombstone the deletion atomically so it propagates on the next sync (Phase 11).
    await this.driver.transaction([
      { sql: 'DELETE FROM item_attachments WHERE id = ?;', params: [id] },
      tombstoneStatement('item_attachments', id),
    ]);
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
