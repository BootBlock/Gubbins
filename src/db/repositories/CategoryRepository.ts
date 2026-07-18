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
import { validateFieldValue } from '@/features/inventory/custom-fields';
import {
  buildAncestorChain,
  findInheritedValue,
  resolveFieldValue,
  type AncestorLocation,
  type InheritableOffer,
} from '@/features/inventory/location-inheritance';
import { DbError } from '../errors';
import type { SqlStatement, SqlValue } from '../rpc/driver';
import { BaseRepository } from './base';
import type { FieldType } from './constants';
import { rowToCategory, rowToCategoryField, rowToFieldDef, rowToLocationFieldValue } from './mappers';
import { tombstoneStatement } from './tombstone';
import type {
  Category,
  CategoryField,
  CategoryFieldRow,
  CategoryRow,
  CategoryWithFieldCount,
  CreateCategoryFieldInput,
  CreateCategoryInput,
  FieldDef,
  FieldDefRow,
  FieldValueMode,
  LocationFieldValue,
  LocationFieldValueRow,
  Page,
  PageParams,
  ResolvedItemField,
  SetLocationFieldValueInput,
  UpdateCategoryFieldInput,
  UpdateCategoryInput,
} from './types';

/**
 * The sentinel a caller passes to {@link CategoryRepository.setItemFieldValues} to mean
 * "inherit this field from the location" (issue #97) rather than to store a literal.
 *
 * It is deliberately a value no custom field can legitimately hold — the angle brackets
 * cannot survive validation as a URL, number, date, rating, boolean or SELECT option, and
 * a TEXT field storing this exact string is a knowingly odd edge the UI never produces.
 */
export const INHERIT_VALUE = '<inherit>';

/** Pre-loaded ancestry + offers for resolving inheritance across a set of items. */
interface InheritanceContext {
  readonly chainByItem: ReadonlyMap<string, AncestorLocation[]>;
  readonly offers: readonly InheritableOffer[];
}

/** The "nothing inherits anything" context — no ancestry to walk, no offers to match. */
const EMPTY_INHERITANCE_CONTEXT: InheritanceContext = { chainByItem: new Map(), offers: [] };

interface CategoryCountRow extends CategoryRow {
  readonly field_count: number;
}

/**
 * Normalise a category glyph for storage (issue #83): trim surrounding whitespace and treat
 * an empty result as "no glyph" (null). A defensive length cap keeps a stray paste from
 * storing an essay where a single emoji belongs — a glyph is a handful of code points, so
 * 16 chars is ample headroom for a multi-code-point emoji (skin tone, ZWJ sequence).
 */
function normaliseGlyph(glyph: string | null | undefined): string | null {
  if (glyph == null) return null;
  const trimmed = glyph.trim();
  if (trimmed.length === 0) return null;
  return trimmed.slice(0, 16);
}

/**
 * The projection that reassembles a {@link CategoryField} from the normalised storage:
 * the category's use of the field (`category_fields`) joined to the dictionary
 * definition it references (`field_defs`). Storage is normalised so a definition can be
 * shared with locations for inheritance (issue #97); the DTO stays flat, so callers are
 * unaffected by the split. Assumes the aliases `cf` and `fd`.
 */
const CATEGORY_FIELD_COLUMNS = `
  cf.id, cf.category_id, cf.def_id, cf.is_required, cf.default_value, cf.position, cf.updated_at,
  fd.name, fd.field_type, fd.options, fd.description
`;

interface ResolvedFieldRow extends CategoryFieldRow {
  readonly stored_value: string | null;
  readonly has_stored: number;
  readonly stored_mode: FieldValueMode | null;
}

export class CategoryRepository extends BaseRepository {
  async getById(id: string): Promise<Category | undefined> {
    const row = await this.driver.queryOne<CategoryRow>('SELECT * FROM categories WHERE id = ?;', [id]);
    return row ? rowToCategory(row) : undefined;
  }

  /** Paginated list of categories with their custom-field counts. */
  async list(params: PageParams = {}): Promise<Page<CategoryWithFieldCount>> {
    const { limit, offset } = this.resolvePage(params);
    const rows = await this.driver.query<CategoryCountRow>(
      `SELECT c.id, c.name, c.glyph, c.default_tracking_mode, c.default_condition, c.default_warranty_months,
              c.default_maintenance_basis, c.default_maintenance_interval_days,
              c.default_maintenance_interval_usage,
              c.updated_at, COUNT(f.id) AS field_count
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
    await this.driver.execute(
      `INSERT INTO categories
         (id, name, glyph, default_tracking_mode, default_condition, default_warranty_months,
          default_maintenance_basis, default_maintenance_interval_days, default_maintenance_interval_usage)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?);`,
      [
        id,
        name,
        normaliseGlyph(input.glyph),
        input.defaultTrackingMode ?? null,
        input.defaultCondition ?? null,
        input.defaultWarrantyMonths ?? null,
        input.defaultMaintenanceBasis ?? null,
        input.defaultMaintenanceIntervalDays ?? null,
        input.defaultMaintenanceIntervalUsage ?? null,
      ],
    );
    return (await this.getById(id))!;
  }

  async update(id: string, input: UpdateCategoryInput): Promise<Category> {
    this.assertWritable();
    await this.requireCategory(id);
    // Plain LWW columns (no history action): assemble only the provided fields so an update
    // touching just one leaves the rest untouched. The `default_*` columns are category
    // template defaults (backlog T1/T2); passing null clears one.
    const sets: string[] = [];
    const params: SqlValue[] = [];
    if (input.name !== undefined) {
      const name = input.name.trim();
      if (name.length === 0) {
        throw new DbError('SQLITE_CONSTRAINT', 'A category must have a name.');
      }
      sets.push('name = ?');
      params.push(name);
    }
    if (input.glyph !== undefined) {
      sets.push('glyph = ?');
      params.push(normaliseGlyph(input.glyph));
    }
    if (input.defaultTrackingMode !== undefined) {
      sets.push('default_tracking_mode = ?');
      params.push(input.defaultTrackingMode);
    }
    if (input.defaultCondition !== undefined) {
      sets.push('default_condition = ?');
      params.push(input.defaultCondition);
    }
    if (input.defaultWarrantyMonths !== undefined) {
      sets.push('default_warranty_months = ?');
      params.push(input.defaultWarrantyMonths);
    }
    if (input.defaultMaintenanceBasis !== undefined) {
      sets.push('default_maintenance_basis = ?');
      params.push(input.defaultMaintenanceBasis);
    }
    if (input.defaultMaintenanceIntervalDays !== undefined) {
      sets.push('default_maintenance_interval_days = ?');
      params.push(input.defaultMaintenanceIntervalDays);
    }
    if (input.defaultMaintenanceIntervalUsage !== undefined) {
      sets.push('default_maintenance_interval_usage = ?');
      params.push(input.defaultMaintenanceIntervalUsage);
    }
    if (sets.length > 0) {
      params.push(id);
      await this.driver.execute(`UPDATE categories SET ${sets.join(', ')} WHERE id = ?;`, params);
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
      `SELECT ${CATEGORY_FIELD_COLUMNS} FROM category_fields cf
       JOIN field_defs fd ON fd.id = cf.def_id
       WHERE cf.category_id = ?
       ORDER BY cf.position ASC, fd.name COLLATE NOCASE ASC;`,
      [categoryId],
    );
    return rows.map(rowToCategoryField);
  }

  /**
   * Every custom-field definition across all categories, ordered by category then declared
   * position (backlog E1 — the item-card field picker offers each custom field as a
   * selectable card field). Bounded by the category × field count (not the 100k+ item set),
   * so it reads the whole set like {@link listFields} — no pagination.
   */
  async listAllFields(): Promise<CategoryField[]> {
    const rows = await this.driver.query<CategoryFieldRow>(
      `SELECT ${CATEGORY_FIELD_COLUMNS} FROM category_fields cf
       JOIN field_defs fd ON fd.id = cf.def_id
       ORDER BY cf.category_id ASC, cf.position ASC, fd.name COLLATE NOCASE ASC;`,
    );
    return rows.map(rowToCategoryField);
  }

  /**
   * The whole global field dictionary (issue #97), alphabetical. Bounded by the number of
   * *distinct* fields the user has defined — far smaller than the item set — so it reads
   * whole. Feeds the location field picker, which offers any definition for a location to
   * set a value against.
   */
  async listFieldDefs(): Promise<FieldDef[]> {
    const rows = await this.driver.query<FieldDefRow>(
      `SELECT * FROM field_defs ORDER BY name COLLATE NOCASE ASC;`,
    );
    return rows.map(rowToFieldDef);
  }

  /**
   * Resolve a dictionary definition by name, creating it when absent (issue #97).
   *
   * Reuse by name is the mechanism that keeps the dictionary from fragmenting: two
   * categories that both declare "Manufacturer" must land on the *same* definition, or a
   * location's inheritable Manufacturer would reach items in one category and silently
   * miss the other. Matching is case-insensitive, mirroring the table's NOCASE unique index.
   *
   * A name that already exists with a **different** field type is rejected rather than
   * retyping the shared definition out from under every other category and location using
   * it — that would reinterpret stored values app-wide as a side effect of adding a field.
   */
  private async resolveFieldDef(
    input: { name: string; fieldType: FieldType; options: string | null; description?: string | null },
    statements: SqlStatement[],
  ): Promise<string> {
    const existing = await this.driver.queryOne<FieldDefRow>(
      'SELECT * FROM field_defs WHERE name = ? COLLATE NOCASE;',
      [input.name],
    );
    if (existing) {
      if (existing.field_type !== input.fieldType) {
        throw new DbError(
          'SQLITE_CONSTRAINT',
          `The field "${input.name}" already exists as a ${existing.field_type} field. ` +
            `Rename this field, or change the existing one's type, rather than defining it twice.`,
        );
      }
      return existing.id;
    }
    const id = crypto.randomUUID();
    statements.push({
      sql: `INSERT INTO field_defs (id, name, field_type, options, description) VALUES (?, ?, ?, ?, ?);`,
      params: [id, input.name, input.fieldType, input.options, input.description ?? null],
    });
    return id;
  }

  /**
   * Load everything needed to resolve **location inheritance** (issue #97) for a set of
   * items: each item's ancestry chain and the inheritable values offered along it.
   *
   * Reads the location tree and the inheritable offers *whole* rather than per item. Both
   * are bounded by the number of locations and of distinct definitions — user-scale sets,
   * orders of magnitude below the 100k+ item ceiling — so this is two constant queries
   * regardless of how many items are being resolved, instead of a walk per item. The
   * precedence logic itself lives in the pure `location-inheritance` seam.
   */
  private async loadInheritanceContext(itemIds: readonly string[]): Promise<InheritanceContext> {
    // An empty id list would interpolate to `IN ()` — a SQLite syntax error, not an empty
    // result. Every current caller guards, but the guard belongs here so a future one can't
    // reintroduce it.
    if (itemIds.length === 0) return EMPTY_INHERITANCE_CONTEXT;
    const placeholders = itemIds.map(() => '?').join(', ');
    const [itemRows, locationRows, offerRows] = await Promise.all([
      this.driver.query<{ id: string; location_id: string }>(
        `SELECT id, location_id FROM items WHERE id IN (${placeholders});`,
        itemIds as SqlValue[],
      ),
      this.driver.query<{ id: string; name: string; parent_id: string | null }>(
        'SELECT id, name, parent_id FROM locations;',
      ),
      this.driver.query<{ location_id: string; def_id: string; value: string | null }>(
        'SELECT location_id, def_id, value FROM location_field_values WHERE is_inheritable = 1;',
      ),
    ]);

    const parents = new Map(locationRows.map((r) => [r.id, { name: r.name, parentId: r.parent_id }]));
    const offers: InheritableOffer[] = offerRows.map((r) => ({
      locationId: r.location_id,
      defId: r.def_id,
      value: r.value,
    }));

    // Chains are memoised per *location*, not per item: items sharing a location (the
    // common case) resolve the same walk once.
    const chainByLocation = new Map<string, AncestorLocation[]>();
    const chainByItem = new Map<string, AncestorLocation[]>();
    for (const item of itemRows) {
      let chain = chainByLocation.get(item.location_id);
      if (chain === undefined) {
        chain = buildAncestorChain(item.location_id, parents);
        chainByLocation.set(item.location_id, chain);
      }
      chainByItem.set(item.id, chain);
    }
    return { chainByItem, offers };
  }

  /**
   * The custom-field values for a set of items (backlog E1 — item cards render chosen
   * custom fields), keyed `cardFieldId → value` per item where the card-field id is the
   * item's category's `category_fields.id`.
   *
   * Values that the item **inherits** from its location (issue #97) are resolved here too,
   * so a card shows the same value the item's detail view does — a card that silently
   * omitted inherited values would read as missing data. Only fields with an effective
   * value appear; lenient defaulting is still applied at render from the field catalog.
   * Empty ids ⇒ empty map (no query).
   */
  async getItemFieldValues(itemIds: readonly string[]): Promise<Map<string, Map<string, string>>> {
    const out = new Map<string, Map<string, string>>();
    if (itemIds.length === 0) return out;
    const placeholders = itemIds.map(() => '?').join(', ');

    // Join through the item's own category so the result is keyed by the card-field id
    // (the category's use of the definition) while the value rows key on the definition.
    const rows = await this.driver.query<{
      item_id: string;
      field_id: string;
      def_id: string;
      value: string | null;
      mode: FieldValueMode;
    }>(
      `SELECT ifv.item_id, cf.id AS field_id, ifv.def_id, ifv.value, ifv.mode
       FROM item_field_values ifv
       JOIN items i ON i.id = ifv.item_id
       JOIN category_fields cf ON cf.def_id = ifv.def_id AND cf.category_id = i.category_id
       WHERE ifv.item_id IN (${placeholders});`,
      itemIds as SqlValue[],
    );

    // Only pay for the location tree when a row actually defers to it. This runs per
    // resident window as the virtualised list scrolls, and in an inventory where nothing
    // inherits, the two extra whole-table reads would be pure waste on a hot path.
    const context = rows.some((r) => r.mode === 'inherit')
      ? await this.loadInheritanceContext(itemIds)
      : EMPTY_INHERITANCE_CONTEXT;

    for (const row of rows) {
      const effective =
        row.mode === 'inherit'
          ? (findInheritedValue(context.chainByItem.get(row.item_id) ?? [], context.offers, row.def_id)
              ?.value ?? null)
          : row.value;
      if (effective === null) continue;

      let byField = out.get(row.item_id);
      if (byField === undefined) {
        byField = new Map<string, string>();
        out.set(row.item_id, byField);
      }
      byField.set(row.field_id, effective);
    }
    return out;
  }

  /**
   * Add a custom field to a category. The identity half resolves against the global
   * dictionary via {@link resolveFieldDef} (reusing an existing definition by name, or
   * creating one); the row written here carries only the category-local policy.
   *
   * Adding a field the category already has is rejected by the table's
   * `UNIQUE (category_id, def_id)` — a category uses each definition at most once.
   */
  async addField(categoryId: string, input: CreateCategoryFieldInput): Promise<CategoryField> {
    this.assertWritable();
    await this.requireCategory(categoryId);
    const { name, fieldType, options } = this.validateFieldInput(input);

    // Definition creation and the category's use of it land in one transaction, so a
    // failure can never leave an orphan definition behind.
    const statements: SqlStatement[] = [];
    const defId = await this.resolveFieldDef(
      { name, fieldType, options, description: input.description },
      statements,
    );

    const id = crypto.randomUUID();
    statements.push({
      sql: `INSERT INTO category_fields
              (id, category_id, def_id, is_required, default_value, position)
            VALUES (?, ?, ?, ?, ?, ?);`,
      params: [
        id,
        categoryId,
        defId,
        input.isRequired ? 1 : 0,
        input.defaultValue ?? null,
        input.position ?? 0,
      ],
    });
    await this.driver.transaction(statements);
    return await this.requireField(id);
  }

  /**
   * Update a category's custom field. The write splits across the two tables the field
   * now spans: the **identity** half (name/type/options/description) edits the shared
   * dictionary definition and is therefore visible to every category and location using
   * it, while the **policy** half (required/default/position) stays category-local.
   *
   * Renaming is deliberately a dictionary edit rather than a fork: the whole point of the
   * shared definition is that a location's inheritable "Manufacturer" and an item's
   * "Manufacturer" are the same field, so a rename must move both together.
   */
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

    const statements: SqlStatement[] = [];

    // --- identity → field_defs (shared) ---
    const defSets: string[] = [];
    const defParams: SqlValue[] = [];
    if (input.name !== undefined) {
      // A rename onto a name another definition already holds would collide with the
      // NOCASE unique index; report it in the app's voice rather than as a raw SQLite error.
      const clash = await this.driver.queryOne<{ id: string }>(
        'SELECT id FROM field_defs WHERE name = ? COLLATE NOCASE AND id <> ?;',
        [validated.name, existing.defId],
      );
      if (clash) {
        throw new DbError(
          'SQLITE_CONSTRAINT',
          `A field named "${validated.name}" already exists. Field names identify a field across ` +
            `every category and location, so they must be unique.`,
        );
      }
      defSets.push('name = ?');
      defParams.push(validated.name);
    }
    if (input.fieldType !== undefined || input.options !== undefined) {
      // Retyping is refused while another category shares the definition, mirroring the
      // guard in `addField`: the type change would reinterpret every stored value under
      // categories the user isn't looking at, silently invalidating them. Changing the
      // option list is safe by comparison, so only a genuine *type* change is blocked.
      if (input.fieldType !== undefined && input.fieldType !== existing.fieldType) {
        const sharers = await this.driver.queryOne<{ n: number }>(
          'SELECT COUNT(*) AS n FROM category_fields WHERE def_id = ? AND id <> ?;',
          [existing.defId, fieldId],
        );
        if ((sharers?.n ?? 0) > 0) {
          throw new DbError(
            'SQLITE_CONSTRAINT',
            `"${existing.name}" is shared with ${sharers!.n} other categor${sharers!.n === 1 ? 'y' : 'ies'}, ` +
              `so its type cannot be changed here — that would reinterpret the values stored under them. ` +
              `Remove it from the others first, or rename this one to create a separate field.`,
          );
        }
      }
      defSets.push('field_type = ?', 'options = ?');
      defParams.push(validated.fieldType, validated.options);
    }
    if (input.description !== undefined) {
      defSets.push('description = ?');
      defParams.push(input.description);
    }
    if (defSets.length > 0) {
      statements.push({
        sql: `UPDATE field_defs SET ${defSets.join(', ')} WHERE id = ?;`,
        params: [...defParams, existing.defId],
      });
    }

    // --- policy → category_fields (category-local) ---
    const sets: string[] = [];
    const params: SqlValue[] = [];
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
      statements.push({
        sql: `UPDATE category_fields SET ${sets.join(', ')} WHERE id = ?;`,
        params: [...params, fieldId],
      });
    }

    if (statements.length > 0) await this.driver.transaction(statements);
    return this.requireField(fieldId);
  }

  /**
   * Remove a custom field from a category.
   *
   * Since issue #97 the item values key on the shared **definition**, not on this row, so
   * dropping it no longer cascades them — the values must be cleared explicitly or they
   * would linger invisibly, sync to peers forever, and reappear if the field were ever
   * re-added. They are scoped to the items *in this category*: the definition may still be
   * in use elsewhere, and an item under another category keeps its own value.
   *
   * The definition itself is deliberately left in the dictionary. It is shared vocabulary —
   * other categories or locations may still use it, and one still exists to be re-picked.
   */
  async deleteField(fieldId: string): Promise<void> {
    const field = await this.driver.queryOne<{ def_id: string; category_id: string }>(
      'SELECT def_id, category_id FROM category_fields WHERE id = ?;',
      [fieldId],
    );
    if (!field) return;

    // Each cleared value is a synced row deletion, so each needs its own tombstone
    // (§7.2 — a cascade records none, and here there is no cascade at all).
    const orphaned = await this.driver.query<{ id: string }>(
      `SELECT ifv.id FROM item_field_values ifv
       JOIN items i ON i.id = ifv.item_id
       WHERE ifv.def_id = ? AND i.category_id IS ?;`,
      [field.def_id, field.category_id],
    );

    await this.driver.transaction([
      ...orphaned.flatMap(({ id }) => [
        { sql: 'DELETE FROM item_field_values WHERE id = ?;', params: [id] },
        tombstoneStatement('item_field_values', id),
      ]),
      { sql: 'DELETE FROM category_fields WHERE id = ?;', params: [fieldId] },
      tombstoneStatement('category_fields', fieldId),
    ]);
  }

  // --- per-item field values (lenient defaulting, §4) ----------------------------

  /**
   * Resolve every custom field of an item's category against its stored values,
   * applying **location inheritance** (issue #97) and then lenient defaulting: a stored
   * literal wins, else the nearest ancestor location's inheritable value when the item's
   * mode is `inherit`, else the field default (or null). Returns [] when the item has no
   * category.
   *
   * Each field also carries the inheritable value *available* to it — whether or not it
   * is currently inheriting — so the editor can offer `<Inherit>` and show what it would
   * resolve to. The precedence itself lives in the pure `location-inheritance` seam.
   */
  async resolveItemFields(itemId: string): Promise<ResolvedItemField[]> {
    const [rows, context] = await Promise.all([
      this.driver.query<ResolvedFieldRow>(
        `SELECT ${CATEGORY_FIELD_COLUMNS},
                ifv.value AS stored_value,
                ifv.mode  AS stored_mode,
                (ifv.id IS NOT NULL) AS has_stored
         FROM category_fields cf
         JOIN field_defs fd ON fd.id = cf.def_id
         LEFT JOIN item_field_values ifv
           ON ifv.def_id = cf.def_id AND ifv.item_id = ?
         WHERE cf.category_id = (SELECT category_id FROM items WHERE id = ?)
         ORDER BY cf.position ASC, fd.name COLLATE NOCASE ASC;`,
        [itemId, itemId],
      ),
      this.loadInheritanceContext([itemId]),
    ]);

    const chain = context.chainByItem.get(itemId) ?? [];
    return rows.map((row) => {
      const field = rowToCategoryField(row);
      const hasStored = row.has_stored === 1;
      const inheritable = findInheritedValue(chain, context.offers, field.defId);
      const resolved = resolveFieldValue(
        hasStored ? { mode: row.stored_mode ?? 'literal', value: row.stored_value } : undefined,
        inheritable,
        field.defaultValue,
      );
      return {
        ...field,
        hasStoredValue: hasStored,
        value: resolved.value,
        mode: resolved.mode,
        source: resolved.source,
        inheritable: resolved.inheritable,
      };
    });
  }

  /**
   * Upsert (or clear, when value is null) a set of an item's custom-field values
   * atomically. Each field must belong to the item's current category. Write-gated.
   *
   * Passing {@link INHERIT_VALUE} for a field stores the *intent* to inherit (issue #97)
   * rather than a value: the field then resolves against the nearest ancestor location
   * offering that definition, live, so moving the item re-resolves it. Inheriting is only
   * accepted where an ancestor actually offers the definition — otherwise the item would
   * store an intent that silently does nothing.
   *
   * Keys are `category_fields.id` (what callers hold); they are translated to the
   * definition id the value rows key on.
   */
  async setItemFieldValues(itemId: string, values: Readonly<Record<string, string | null>>): Promise<void> {
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

    // Fetch each field's *full* definition (type/options/required/name), not just
    // its id, so the value can be validated and canonically coerced before it is
    // persisted (Phase 70 — typed-valid at the point of save). Reuses the shared
    // `rowToCategoryField` mapper for one source of truth on the DTO shape.
    const fieldRows = await this.driver.query<CategoryFieldRow>(
      `SELECT ${CATEGORY_FIELD_COLUMNS} FROM category_fields cf
       JOIN field_defs fd ON fd.id = cf.def_id
       WHERE cf.category_id IS ?;`,
      [item.category_id],
    );
    const fieldById = new Map(fieldRows.map((r) => [r.id, rowToCategoryField(r)]));

    // Existing value-row ids (def_id → id) so a clear can tombstone by id (Phase 11:
    // item_field_values is synced; a cleared value must propagate as a deletion).
    const existingRows = await this.driver.query<{ id: string; def_id: string }>(
      'SELECT id, def_id FROM item_field_values WHERE item_id = ?;',
      [itemId],
    );
    const valueIdByDef = new Map(existingRows.map((r) => [r.def_id, r.id]));

    // Only loaded if some field is actually being set to inherit — the common save
    // touches no inherited field and should not pay for the tree read.
    let context: InheritanceContext | null = null;

    const statements: SqlStatement[] = [];
    for (const [fieldId, rawValue] of entries) {
      const def = fieldById.get(fieldId);
      if (def === undefined) {
        throw new DbError('SQLITE_CONSTRAINT', `Field "${fieldId}" does not belong to this item's category.`);
      }

      if (rawValue === INHERIT_VALUE) {
        context ??= await this.loadInheritanceContext([itemId]);
        const offered = findInheritedValue(context.chainByItem.get(itemId) ?? [], context.offers, def.defId);
        // A required field must not inherit a blank. Locations validate their values with
        // `isRequired: false` (required-ness is the category's policy for items, not a
        // constraint on the location), so an inheritable-but-empty offer would otherwise
        // slip a required field past validation and leave it resolving to null.
        if (offered !== null && def.isRequired && (offered.value === null || offered.value.trim() === '')) {
          throw new DbError(
            'SQLITE_CONSTRAINT',
            `${def.name} is required, and ${offered.locationName} offers no value for it — ` +
              `set a value on that location, or enter one for this item.`,
          );
        }
        if (offered === null) {
          throw new DbError(
            'SQLITE_CONSTRAINT',
            `${def.name} cannot be inherited here — no location above this item offers a value for it.`,
          );
        }
        statements.push({
          sql: `INSERT INTO item_field_values (id, item_id, def_id, value, mode)
                VALUES (?, ?, ?, NULL, 'inherit')
                ON CONFLICT (item_id, def_id)
                  DO UPDATE SET value = NULL, mode = 'inherit';`,
          params: [crypto.randomUUID(), itemId, def.defId],
        });
        continue;
      }

      // Validate + canonically coerce the incoming value against its definition.
      // A failure rejects the whole write; a success yields the *normalised* string
      // to persist (e.g. NUMBER '1.50' → '1.5'), or null to clear/tombstone the row.
      const result = validateFieldValue(def, rawValue);
      if (!result.ok) {
        throw new DbError('SQLITE_CONSTRAINT', result.error);
      }
      const value = result.value;

      if (value === null) {
        const existingId = valueIdByDef.get(def.defId);
        if (existingId !== undefined) {
          statements.push({
            sql: 'DELETE FROM item_field_values WHERE id = ?;',
            params: [existingId],
          });
          statements.push(tombstoneStatement('item_field_values', existingId));
        }
      } else {
        statements.push({
          sql: `INSERT INTO item_field_values (id, item_id, def_id, value, mode)
                VALUES (?, ?, ?, ?, 'literal')
                ON CONFLICT (item_id, def_id)
                  DO UPDATE SET value = excluded.value, mode = 'literal';`,
          params: [crypto.randomUUID(), itemId, def.defId, value],
        });
      }
    }
    if (statements.length === 0) return;
    await this.driver.transaction(statements);
  }

  // --- location field values (issue #97) -----------------------------------------

  /**
   * The custom-field values a location holds, joined to their dictionary definitions and
   * ordered by field name. Includes non-inheritable rows: the location's editor shows
   * every value it has set, with inheritability as a per-row toggle.
   */
  async listLocationFieldValues(locationId: string): Promise<LocationFieldValue[]> {
    const rows = await this.driver.query<
      LocationFieldValueRow & {
        name: string;
        field_type: FieldType;
        options: string | null;
        description: string | null;
      }
    >(
      `SELECT lfv.*, fd.name, fd.field_type, fd.options, fd.description
       FROM location_field_values lfv
       JOIN field_defs fd ON fd.id = lfv.def_id
       WHERE lfv.location_id = ?
       ORDER BY fd.name COLLATE NOCASE ASC;`,
      [locationId],
    );
    return rows.map(rowToLocationFieldValue);
  }

  /**
   * Set a location's value for a dictionary definition, creating the row if absent.
   *
   * The value is validated against its definition through the same seam item values go
   * through, so a location can never offer a value the inheriting item would reject — an
   * invalid inherited value would otherwise surface as a broken field on every item below.
   * Required-ness is category-local policy and does not apply here, so a **blank value is
   * kept as a row holding NULL** rather than rejected or silently deleted: a location needs
   * to be able to hold an as-yet-unfilled field, and deleting is a separate, explicit act
   * (see {@link removeLocationFieldValue}).
   */
  async setLocationFieldValue(
    locationId: string,
    input: SetLocationFieldValueInput,
  ): Promise<LocationFieldValue | null> {
    this.assertWritable();
    const def = await this.driver.queryOne<FieldDefRow>('SELECT * FROM field_defs WHERE id = ?;', [
      input.defId,
    ]);
    if (!def) {
      throw new DbError('SQLITE_CONSTRAINT', `Custom field "${input.defId}" does not exist.`);
    }
    const existing = await this.driver.queryOne<{ id: string }>(
      'SELECT id FROM location_field_values WHERE location_id = ? AND def_id = ?;',
      [locationId, input.defId],
    );

    // Validate as a *location* value: `isRequired` is false here regardless of any
    // category's policy, so a blank is valid and coerces to NULL.
    const result = validateFieldValue({ ...rowToFieldDef(def), isRequired: false }, input.value);
    if (!result.ok) {
      throw new DbError('SQLITE_CONSTRAINT', result.error);
    }

    await this.driver.execute(
      `INSERT INTO location_field_values (id, location_id, def_id, value, is_inheritable)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (location_id, def_id)
         DO UPDATE SET value = excluded.value, is_inheritable = excluded.is_inheritable;`,
      [
        existing?.id ?? crypto.randomUUID(),
        locationId,
        input.defId,
        result.value,
        input.isInheritable ? 1 : 0,
      ],
    );
    const rows = await this.listLocationFieldValues(locationId);
    return rows.find((r) => r.defId === input.defId) ?? null;
  }

  /**
   * Remove a location's value for a definition entirely. Distinct from storing a blank:
   * this drops the row, so the location stops offering the field and anything beneath it
   * that was inheriting falls back to the next ancestor offering it (or to the category
   * default). Tombstoned, since `location_field_values` is synced.
   */
  async removeLocationFieldValue(locationId: string, defId: string): Promise<void> {
    this.assertWritable();
    const existing = await this.driver.queryOne<{ id: string }>(
      'SELECT id FROM location_field_values WHERE location_id = ? AND def_id = ?;',
      [locationId, defId],
    );
    if (!existing) return;
    await this.driver.transaction([
      { sql: 'DELETE FROM location_field_values WHERE id = ?;', params: [existing.id] },
      tombstoneStatement('location_field_values', existing.id),
    ]);
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
      `SELECT ${CATEGORY_FIELD_COLUMNS} FROM category_fields cf
       JOIN field_defs fd ON fd.id = cf.def_id
       WHERE cf.id = ?;`,
      [id],
    );
    if (!row) {
      throw new DbError('SQLITE_CONSTRAINT', `Custom field "${id}" does not exist.`);
    }
    return rowToCategoryField(row);
  }

  /** Validate a field's name and (for SELECT) non-empty options; serialise options. */
  private validateFieldInput(input: { name: string; fieldType: FieldType; options?: string[] | null }): {
    name: string;
    fieldType: FieldType;
    options: string | null;
  } {
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
