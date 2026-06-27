/**
 * ContactRepository (spec §2.1.1, §4 "Borrowing & Checking Out", Phase 6).
 *
 * The dedicated Contacts dictionary that tracks who has borrowed what. Adding a
 * contact is deliberately low-friction (§4 Ergonomics): {@link resolveOrCreate}
 * looks a name up case-insensitively and creates it on the fly, so the checkout
 * box can mint a contact from a typed name without sending the user to a separate
 * setup screen. Creation grows storage and is therefore Hard-Stop gated; deletes
 * (which free space) are not.
 */
import { DbError } from '../errors';
import { BaseRepository } from './base';
import { rowToContact } from './mappers';
import { tombstoneStatement } from './tombstone';
import type {
  Contact,
  ContactRow,
  ContactWithCount,
  CreateContactInput,
  Page,
  PageParams,
  UpdateContactInput,
} from './types';

interface ContactCountRow extends ContactRow {
  readonly open_count: number;
}

export class ContactRepository extends BaseRepository {
  async getById(id: string): Promise<Contact | undefined> {
    const row = await this.driver.queryOne<ContactRow>('SELECT * FROM contacts WHERE id = ?;', [id]);
    return row ? rowToContact(row) : undefined;
  }

  /** Paginated contacts with a live count of still-out (open) checkouts, by name. */
  async list(params: PageParams = {}): Promise<Page<ContactWithCount>> {
    const { limit, offset } = this.resolvePage(params);
    const rows = await this.driver.query<ContactCountRow>(
      `SELECT c.*,
              (SELECT COUNT(*) FROM checkouts k
               WHERE k.contact_id = c.id AND k.returned_at IS NULL) AS open_count
       FROM contacts c
       ORDER BY c.name COLLATE NOCASE ASC
       LIMIT ? OFFSET ?;`,
      [limit, offset],
    );
    return this.toPage(
      rows.map((r) => ({ ...rowToContact(r), openCount: Number(r.open_count) })),
      limit,
      offset,
    );
  }

  /** Look a contact up by name (case-insensitive), or `undefined`. */
  async findByName(name: string): Promise<Contact | undefined> {
    const trimmed = name.trim();
    if (trimmed.length === 0) return undefined;
    const row = await this.driver.queryOne<ContactRow>(
      'SELECT * FROM contacts WHERE name = ? COLLATE NOCASE;',
      [trimmed],
    );
    return row ? rowToContact(row) : undefined;
  }

  async create(input: CreateContactInput): Promise<Contact> {
    this.assertWritable();
    const name = input.name.trim();
    if (name.length === 0) {
      throw new DbError('SQLITE_CONSTRAINT', 'A contact must have a name.');
    }
    const id = crypto.randomUUID();
    await this.driver.execute('INSERT INTO contacts (id, name, note) VALUES (?, ?, ?);', [
      id,
      name,
      input.note?.trim() || null,
    ]);
    return (await this.getById(id))!;
  }

  /**
   * Low-friction lookup-or-create (§4 Ergonomics): returns the existing contact
   * with this name (case-insensitive) or mints a new one. The race between the
   * lookup and the insert is closed by the case-insensitive UNIQUE index — a
   * concurrent create surfaces as a constraint error, which we resolve by re-reading.
   */
  async resolveOrCreate(name: string): Promise<Contact> {
    const existing = await this.findByName(name);
    if (existing) return existing;
    try {
      return await this.create({ name });
    } catch (error) {
      const fallback = await this.findByName(name);
      if (fallback) return fallback;
      throw error;
    }
  }

  async update(id: string, input: UpdateContactInput): Promise<Contact> {
    this.assertWritable();
    await this.require(id);
    const sets: string[] = [];
    const params: (string | null)[] = [];
    if (input.name !== undefined) {
      const name = input.name.trim();
      if (name.length === 0) {
        throw new DbError('SQLITE_CONSTRAINT', 'A contact must have a name.');
      }
      sets.push('name = ?');
      params.push(name);
    }
    if (input.note !== undefined) {
      sets.push('note = ?');
      params.push(input.note?.trim() || null);
    }
    if (sets.length > 0) {
      await this.driver.execute(`UPDATE contacts SET ${sets.join(', ')} WHERE id = ?;`, [
        ...params,
        id,
      ]);
    }
    return (await this.getById(id))!;
  }

  /**
   * Delete a contact (cascades their checkout records). Bypasses the Hard Stop.
   * Records a tombstone in the same transaction so the deletion syncs (§7.2). The
   * cascaded checkouts are implied by the contact tombstone (the remote cascades too).
   */
  async delete(id: string): Promise<void> {
    await this.driver.transaction([
      { sql: 'DELETE FROM contacts WHERE id = ?;', params: [id] },
      tombstoneStatement('contacts', id),
    ]);
  }

  private async require(id: string): Promise<Contact> {
    const contact = await this.getById(id);
    if (!contact) {
      throw new DbError('SQLITE_CONSTRAINT', `Contact "${id}" does not exist.`);
    }
    return contact;
  }
}
