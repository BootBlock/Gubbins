/**
 * CategoryRepository (spec §2.1.1, §4 "Categories & Schema Evolution").
 *
 * Owns categories, their dynamic custom-field *definitions* (`category_fields`),
 * and the resolution of a specific item's field *values* (`item_field_values`)
 * with **lenient defaulting**: a field with no stored value row resolves silently
 * to its `defaultValue` (or null), so adding or changing a category's schema never
 * needs to back-fill existing items (§4). Field definitions form a bounded set per
 * category, so `listFields` reads them whole; per-item value reads are bounded by
 * the category's field count, not the 100k+ item set, so they need no pagination.
 */
import { DbError } from '../errors';
import type { SqlStatement, SqlValue } from '../rpc/driver';
import { BaseRepository } from './base';
import { rowToCategory, rowToCategoryField } from './mappers';
import { tombstoneStatement } from './tombstone';
import type {
  Category,
  CategoryField,
  CategoryFieldRow,
  CategoryRow,
  CategoryWithFieldCount,
  CreateCategoryFieldInput,
  CreateCategoryInput,
  Page,
  PageParams,
  ResolvedItemField,
  UpdateCategoryFieldInput,
  UpdateCategoryInput,
} from './types';

interface CategoryCountRow extends CategoryRow {
  readonly field_count: number;
}

interface ResolvedFieldRow extends CategoryFieldRow {
  readonly stored_value: string | null;
  readonly has_stored: number;
}

export class CategoryRepository extends BaseRepository {
  async getById(id: string): Promise<Category | undefined> {
    const row = await this.driver.queryOne<CategoryRow>('SELECT * FROM categories WHERE id = ?;', [
      id,
    ]);
    return row ? rowToCategory(row) : undefined;
  }

  /** Paginated list of categories with their custom-field counts. */
  async list(params: PageParams = {}): Promise<Page<CategoryWithFieldCount>> {
    const { limit, offset } = this.resolvePage(params);
    const rows = await this.driver.query<CategoryCountRow>(
      `SELECT c.id, c.name, c.updated_at, COUNT(f.id) AS field_count
       FROM categories c
       LEFT JOIN category_fields f ON f.category_id = c.id
       GROUP BY c.id
       ORDER BY c.name COLLATE NOCASE ASC
       LIMIT ? OFFSET ?;`,
      [limit, offset],
    );
    return this.toPage(
      rows.map((r) => ({ ...rowToCategory(r), fieldCount: Number(r.field_count) })),
      limit,
      offset,
    );
  }

  async create(input: CreateCategoryInput): Promise<Category> {
    this.assertWritable();
    const name = input.name.trim();
    if (name.length === 0) {
      throw new DbError('SQLITE_CONSTRAINT', 'A category must have a name.');
    }
    const id = crypto.randomUUID();
    await this.driver.execute('INSERT INTO categories (id, name) VALUES (?, ?);', [id, name]);
    return (await this.getById(id))!;
  }

  async update(id: string, input: UpdateCategoryInput): Promise<Category> {
    this.assertWritable();
    await this.requireCategory(id);
    if (input.name !== undefined) {
      const name = input.name.trim();
      if (name.length === 0) {
        throw new DbError('SQLITE_CONSTRAINT', 'A category must have a name.');
      }
      await this.driver.execute('UPDATE categories SET name = ? WHERE id = ?;', [name, id]);
    }
    return (await this.getById(id))!;
  }

  /**
   * Hard delete a category. Its custom-field definitions and the matching value
   * rows cascade away; items keep existing with `category_id` set to NULL
   * (`items.category_id ... ON DELETE SET NULL`), so no item is ever lost.
   * Permitted under the storage Hard Stop (it frees space).
   */
  async delete(id: string): Promise<void> {
    await this.driver.transaction([
      { sql: 'DELETE FROM categories WHERE id = ?;', params: [id] },
      tombstoneStatement('categories', id),
    ]);
  }

  // --- custom fields -------------------------------------------------------------

  /** The custom-field definitions for a category, in declared order. */
  async listFields(categoryId: string): Promise<CategoryField[]> {
    const rows = await this.driver.query<CategoryFieldRow>(
      `SELECT * FROM category_fields WHERE category_id = ?
       ORDER BY position ASC, name COLLATE NOCASE ASC;`,
      [categoryId],
    );
    return rows.map(rowToCategoryField);
  }

  async addField(categoryId: string, input: CreateCategoryFieldInput): Promise<CategoryField> {
    this.assertWritable();
    await this.requireCategory(categoryId);
    const { name, fieldType, options } = this.validateFieldInput(input);

    const id = crypto.randomUUID();
    await this.driver.execute(
      `INSERT INTO category_fields
         (id, category_id, name, field_type, options, is_required, default_value, position)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?);`,
      [
        id,
        categoryId,
        name,
        fieldType,
        options,
        input.isRequired ? 1 : 0,
        input.defaultValue ?? null,
        input.position ?? 0,
      ],
    );
    return (await this.requireField(id));
  }

  async updateField(fieldId: string, input: UpdateCategoryFieldInput): Promise<CategoryField> {
    this.assertWritable();
    const existing = await this.requireField(fieldId);

    // Resolve the *effective* field type/options so a SELECT can never end up with
    // no options regardless of which subset of fields the caller updates.
    const merged = {
      name: input.name ?? existing.name,
      fieldType: input.fieldType ?? existing.fieldType,
      options: input.options !== undefined ? input.options : existing.options,
    };
    const validated = this.validateFieldInput(merged);

    const sets: string[] = [];
    const params: SqlValue[] = [];
    if (input.name !== undefined) {
      sets.push('name = ?');
      params.push(validated.name);
    }
    if (input.fieldType !== undefined || input.options !== undefined) {
      sets.push('field_type = ?', 'options = ?');
      params.push(validated.fieldType, validated.options);
    }
    if (input.isRequired !== undefined) {
      sets.push('is_required = ?');
      params.push(input.isRequired ? 1 : 0);
    }
    if (input.defaultValue !== undefined) {
      sets.push('default_value = ?');
      params.push(input.defaultValue);
    }
    if (input.position !== undefined) {
      sets.push('position = ?');
      params.push(input.position);
    }
    if (sets.length > 0) {
      params.push(fieldId);
      await this.driver.execute(
        `UPDATE category_fields SET ${sets.join(', ')} WHERE id = ?;`,
        params,
      );
    }
    return this.requireField(fieldId);
  }

  async deleteField(fieldId: string): Promise<void> {
    // Tombstone the field-definition deletion (Phase 11: category_fields is synced). Its
    // item_field_values cascade-delete locally and, on a peer, cascade from this same
    // tombstone, so the value rows need no tombstones of their own.
    await this.driver.transaction([
      { sql: 'DELETE FROM category_fields WHERE id = ?;', params: [fieldId] },
      tombstoneStatement('category_fields', fieldId),
    ]);
  }

  // --- per-item field values (lenient defaulting, §4) ----------------------------

  /**
   * Resolve every custom field of an item's category against its stored values,
   * applying lenient defaulting: a missing value row yields the field default (or
   * null) with `hasStoredValue = false`. Returns [] when the item has no category.
   */
  async resolveItemFields(itemId: string): Promise<ResolvedItemField[]> {
    const rows = await this.driver.query<ResolvedFieldRow>(
      `SELECT cf.*, ifv.value AS stored_value,
              (ifv.id IS NOT NULL) AS has_stored
       FROM category_fields cf
       LEFT JOIN item_field_values ifv
         ON ifv.field_id = cf.id AND ifv.item_id = ?
       WHERE cf.category_id = (SELECT category_id FROM items WHERE id = ?)
       ORDER BY cf.position ASC, cf.name COLLATE NOCASE ASC;`,
      [itemId, itemId],
    );
    return rows.map((row) => {
      const field = rowToCategoryField(row);
      const hasStored = row.has_stored === 1;
      return {
        ...field,
        hasStoredValue: hasStored,
        value: hasStored ? row.stored_value : field.defaultValue,
      };
    });
  }

  /**
   * Upsert (or clear, when value is null) a set of an item's custom-field values
   * atomically. Each field must belong to the item's current category. Write-gated.
   */
  async setItemFieldValues(
    itemId: string,
    values: Readonly<Record<string, string | null>>,
  ): Promise<void> {
    this.assertWritable();
    const entries = Object.entries(values);
    if (entries.length === 0) return;

    const item = await this.driver.queryOne<{ category_id: string | null }>(
      'SELECT category_id FROM items WHERE id = ?;',
      [itemId],
    );
    if (!item) {
      throw new DbError('SQLITE_CONSTRAINT', `Item "${itemId}" does not exist.`);
    }

    const fieldRows = await this.driver.query<{ id: string }>(
      'SELECT id FROM category_fields WHERE category_id IS ?;',
      [item.category_id],
    );
    const allowed = new Set(fieldRows.map((f) => f.id));

    // Existing value-row ids (field_id → id) so a clear can tombstone by id (Phase 11:
    // item_field_values is synced; a cleared value must propagate as a deletion).
    const existingRows = await this.driver.query<{ id: string; field_id: string }>(
      'SELECT id, field_id FROM item_field_values WHERE item_id = ?;',
      [itemId],
    );
    const valueIdByField = new Map(existingRows.map((r) => [r.field_id, r.id]));

    const statements: SqlStatement[] = [];
    for (const [fieldId, value] of entries) {
      if (!allowed.has(fieldId)) {
        throw new DbError(
          'SQLITE_CONSTRAINT',
          `Field "${fieldId}" does not belong to this item's category.`,
        );
      }
      if (value === null) {
        const existingId = valueIdByField.get(fieldId);
        if (existingId !== undefined) {
          statements.push({
            sql: 'DELETE FROM item_field_values WHERE id = ?;',
            params: [existingId],
          });
          statements.push(tombstoneStatement('item_field_values', existingId));
        }
      } else {
        statements.push({
          sql: `INSERT INTO item_field_values (id, item_id, field_id, value)
                VALUES (?, ?, ?, ?)
                ON CONFLICT (item_id, field_id) DO UPDATE SET value = excluded.value;`,
          params: [crypto.randomUUID(), itemId, fieldId, value],
        });
      }
    }
    if (statements.length === 0) return;
    await this.driver.transaction(statements);
  }

  // --- internals -----------------------------------------------------------------

  private async requireCategory(id: string): Promise<void> {
    const exists = await this.driver.queryOne('SELECT 1 AS ok FROM categories WHERE id = ?;', [id]);
    if (!exists) {
      throw new DbError('SQLITE_CONSTRAINT', `Category "${id}" does not exist.`);
    }
  }

  private async requireField(id: string): Promise<CategoryField> {
    const row = await this.driver.queryOne<CategoryFieldRow>(
      'SELECT * FROM category_fields WHERE id = ?;',
      [id],
    );
    if (!row) {
      throw new DbError('SQLITE_CONSTRAINT', `Custom field "${id}" does not exist.`);
    }
    return rowToCategoryField(row);
  }

  /** Validate a field's name and (for SELECT) non-empty options; serialise options. */
  private validateFieldInput(input: {
    name: string;
    fieldType: string;
    options?: string[] | null;
  }): { name: string; fieldType: string; options: string | null } {
    const name = input.name.trim();
    if (name.length === 0) {
      throw new DbError('SQLITE_CONSTRAINT', 'A custom field must have a name.');
    }
    if (input.fieldType === 'SELECT') {
      const options = (input.options ?? []).map((o) => o.trim()).filter((o) => o.length > 0);
      if (options.length === 0) {
        throw new DbError('SQLITE_CONSTRAINT', 'A SELECT field requires at least one option.');
      }
      return { name, fieldType: input.fieldType, options: JSON.stringify(options) };
    }
    return { name, fieldType: input.fieldType, options: null };
  }
}
