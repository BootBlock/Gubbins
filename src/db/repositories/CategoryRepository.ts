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
import { KEY_FIELD_PROMINENCE, serialiseFieldDefProminence } from '@/features/inventory/field-def-prominence';
import { normaliseFieldTabLabel } from '@/features/inventory/field-prominence';
import {
  buildAncestorChain,
  findInheritedValue,
  resolveFieldValue,
  type AncestorLocation,
  type InheritableOffer,
} from '@/features/inventory/location-inheritance';
import { foldName } from '@/lib/name-fold';
import { DbError } from '../errors';
import type { SqlStatement, SqlValue } from '../rpc/driver';
import { BaseRepository } from './base';
import {
  FIELD_DUE_LEAD_DAYS_MAX,
  FIELD_DUE_LEAD_DAYS_MIN,
  FIELD_NUMBER_BOUND_LIMIT,
  FIELD_PRECISION_MAX,
  FIELD_PRECISION_MIN,
  FIELD_UNIT_MAX_LENGTH,
  type FieldType,
} from './constants';
import { rowToCategory, rowToCategoryField, rowToFieldDef, rowToLocationFieldValue } from './mappers';
import { tombstoneStatement } from './tombstone';
import type {
  Category,
  CategoryField,
  CategoryFieldRow,
  CategoryLookupSource,
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
  fd.name, fd.field_type, fd.options, fd.description, fd.due_lead_days,
  fd.unit, fd.min_value, fd.max_value, fd.precision, fd.prominence
`;

/**
 * The leading term of every **rendered field set**'s ordering (W1d): a key definition sorts ahead
 * of an ordinary one, and everything else is decided by the existing terms after it.
 *
 * Expressed in SQL rather than left to each caller so that one read produces the canonical order
 * for every consumer at once — the item editor, the category manager, the CSV export's column
 * order, the bridge's `fieldValues` array and the lookup panel's bindings all inherit it without
 * re-sorting, and therefore cannot drift apart — no render surface applies a rank of its own. The
 * pure `orderByFieldProminence` seam is the independently-written counterpart to this term rather
 * than a second live ordering path; a test compares the two against one real read.
 *
 * The comparison is against {@link KEY_FIELD_PROMINENCE} verbatim, which makes it the exact SQL
 * counterpart of `toFieldDefProminence`: any other string — including one a peer on a newer
 * version wrote — simply ranks as ordinary rather than erroring. Assumes the alias `fd`.
 */
const FIELD_PROMINENCE_RANK = `CASE WHEN fd.prominence = '${KEY_FIELD_PROMINENCE}' THEN 0 ELSE 1 END`;

interface ResolvedFieldRow extends CategoryFieldRow {
  readonly stored_value: string | null;
  readonly has_stored: number;
  readonly stored_mode: FieldValueMode | null;
}

/**
 * The projection behind both category list reads, so the paged and whole-set reads can never
 * disagree about the columns or the ordering they return. Callers append their own `LIMIT`.
 */
const SELECT_WITH_FIELD_COUNT = `
  SELECT c.id, c.name, c.glyph, c.default_tracking_mode, c.default_condition, c.default_warranty_months,
         c.default_maintenance_basis, c.default_maintenance_interval_days,
         c.default_maintenance_interval_usage, c.hidden_capabilities, c.lookup_sources,
         c.field_prominence, c.field_tab_label,
         c.updated_at, COUNT(f.id) AS field_count
  FROM categories c
  LEFT JOIN category_fields f ON f.category_id = c.id
  GROUP BY c.id
  ORDER BY c.name COLLATE NOCASE ASC
`;

/**
 * Serialise a category's hidden-capability set (issue #618) for storage.
 *
 * "Nothing hidden" is stored as NULL and never as `"[]"` or `"null"`, so the column has one
 * canonical empty form and an LWW merge can't see two spellings of the same choice as a
 * change. Ids are trimmed, de-duplicated and order-stabilised for the same reason: an editor
 * that reorders the picker must not produce a write that looks like an edit.
 */
function serialiseHiddenCapabilities(ids: readonly string[] | null | undefined): string | null {
  if (ids == null) return null;
  const unique = [...new Set(ids.map((id) => id.trim()).filter((id) => id.length > 0))].sort();
  return unique.length > 0 ? JSON.stringify(unique) : null;
}

/**

 * Serialise a category's attached lookup providers (issue #616) for storage.
 *
 * Canonicalised for the same reason {@link serialiseHiddenCapabilities} is: "no lookups" is
 * always NULL and never `"[]"`, entries are de-duplicated by provider and ordered by id, and
 * an empty `fieldMap` is written as an omitted key rather than `{}`. A picker that reordered
 * its rows must not produce a write that LWW sync reads as an edit.
 *
 * Provider ids are **not** filtered against the registry here. An id this build doesn't
 * recognise came from a peer on a newer version, and dropping it on write would silently
 * discard that peer's choice the moment an older device touched the row.
 */
function serialiseLookupSources(sources: readonly CategoryLookupSource[] | null | undefined): string | null {
  if (sources == null) return null;
  const byProvider = new Map<string, CategoryLookupSource>();
  for (const source of sources) {
    const providerId = source.providerId.trim();
    if (providerId.length === 0 || byProvider.has(providerId)) continue;
    byProvider.set(providerId, { providerId, fieldMap: source.fieldMap });
  }
  if (byProvider.size === 0) return null;
  const entries = [...byProvider.values()]
    .sort((a, b) => (a.providerId < b.providerId ? -1 : a.providerId > b.providerId ? 1 : 0))
    .map(({ providerId, fieldMap }) => {
      // Key order is canonicalised too: `JSON.stringify` emits insertion order, so two
      // pickers that set the same overrides in a different sequence would otherwise store
      // two different strings for one choice.
      const pairs = Object.entries(fieldMap ?? {})
        .filter(([, target]) => target.length > 0)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
      return pairs.length > 0 ? { providerId, fieldMap: Object.fromEntries(pairs) } : { providerId };
    });
  return JSON.stringify(entries);
}

/**
 * Canonicalise a custom-field prominence mode for storage (issue #619).
 *
 * Trimmed, and `'default'` collapsed to NULL: "leave the fields where they are" is the absence of
 * a preference, and storing two spellings of it would make an LWW merge see an edit where the
 * user changed nothing. An unrecognised mode is *not* rejected here — the column keeps whatever a
 * newer peer wrote, and `toFieldProminenceMode` decides what this build renders.
 */
function serialiseFieldProminence(mode: string | null | undefined): string | null {
  if (mode == null) return null;
  const trimmed = mode.trim();
  return trimmed.length === 0 || trimmed === 'default' ? null : trimmed;
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
      `${SELECT_WITH_FIELD_COUNT}
       LIMIT ? OFFSET ?;`,
      [limit, offset],
    );
    return this.toPage(rows.map(toWithFieldCount), limit, offset);
  }

  /**
   * Every category as a flat list — the unpaginated counterpart to {@link list}, justified by
   * the same reasoning as `LocationRepository.listAll` (issue #148): a catalogue's categories
   * are a bounded classification set, not the 100k+ item set the pagination mandate (§2.1)
   * targets, and everything the UI does with them is a *lookup* rather than a scrollable list.
   *
   * Capped, this read gave **wrong** answers rather than short ones once a catalogue held more
   * than a page of categories: an item in the 101st category showed no category name at all, the
   * category facet and the create/edit/bulk-edit pickers could not offer it, and a vault export
   * wrote the item out with its category missing. Use {@link list} where a genuine page is wanted.
   */
  async listAll(): Promise<CategoryWithFieldCount[]> {
    const rows = await this.driver.query<CategoryCountRow>(`${SELECT_WITH_FIELD_COUNT};`);
    return rows.map(toWithFieldCount);
  }

  async create(input: CreateCategoryInput): Promise<Category> {
    this.assertPermission('categories:write');
    this.assertWritable();
    const name = input.name.trim();
    if (name.length === 0) {
      throw new DbError('SQLITE_CONSTRAINT', 'A category must have a name.');
    }
    const id = crypto.randomUUID();
    await this.driver.execute(
      `INSERT INTO categories
         (id, name, glyph, default_tracking_mode, default_condition, default_warranty_months,
          default_maintenance_basis, default_maintenance_interval_days, default_maintenance_interval_usage,
          hidden_capabilities, lookup_sources, field_prominence, field_tab_label)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);`,
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
        serialiseHiddenCapabilities(input.hiddenCapabilities),
        serialiseLookupSources(input.lookupSources),
        serialiseFieldProminence(input.fieldProminence),
        normaliseFieldTabLabel(input.fieldTabLabel),
      ],
    );
    return (await this.getById(id))!;
  }

  async update(id: string, input: UpdateCategoryInput): Promise<Category> {
    this.assertPermission('categories:write');
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
    if (input.hiddenCapabilities !== undefined) {
      sets.push('hidden_capabilities = ?');
      params.push(serialiseHiddenCapabilities(input.hiddenCapabilities));
    }
    if (input.lookupSources !== undefined) {
      sets.push('lookup_sources = ?');
      params.push(serialiseLookupSources(input.lookupSources));
    }
    if (input.fieldProminence !== undefined) {
      sets.push('field_prominence = ?');
      params.push(serialiseFieldProminence(input.fieldProminence));
    }
    if (input.fieldTabLabel !== undefined) {
      sets.push('field_tab_label = ?');
      params.push(normaliseFieldTabLabel(input.fieldTabLabel));
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
    this.assertPermission('categories:delete');
    await this.driver.transaction([
      { sql: 'DELETE FROM categories WHERE id = ?;', params: [id] },
      tombstoneStatement('categories', id),
    ]);
  }

  // --- custom fields -------------------------------------------------------------

  /**
   * The custom-field definitions for a category, in display order: key definitions first (W1d),
   * then the category's own `position`, then name.
   */
  async listFields(categoryId: string): Promise<CategoryField[]> {
    const rows = await this.driver.query<CategoryFieldRow>(
      `SELECT ${CATEGORY_FIELD_COLUMNS} FROM category_fields cf
       JOIN field_defs fd ON fd.id = cf.def_id
       WHERE cf.category_id = ?
       ORDER BY ${FIELD_PROMINENCE_RANK}, cf.position ASC, fd.name COLLATE NOCASE ASC;`,
      [categoryId],
    );
    return rows.map(rowToCategoryField);
  }

  /**
   * Every custom-field definition across all categories, ordered by category then declared
   * position (backlog E1 — the item-card field picker offers each custom field as a
   * selectable card field). Bounded by the category × field count (not the 100k+ item set),
   * so it reads the whole set like {@link listFields} — no pagination.
   *
   * Deliberately **not** ranked by prominence, unlike every other field read: this is a *catalog
   * grouped by category*, not a rendered field set, and the picker labels its rows "name ·
   * category" on the strength of that grouping. Hoisting key definitions to the front would break
   * the grouping to reorder a list the user orders by hand anyway.
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
   * The dictionary definitions nothing references any more — no category uses them, no
   * location sets a value for them, and no item has a value stored against them.
   *
   * These accumulate by design rather than by accident: {@link deleteField} deliberately
   * leaves the definition behind when a category drops a field, because the dictionary is
   * *shared vocabulary* — another category or location may still want it, and silently
   * destroying it would take their field with it. The cost is that a definition whose last
   * user has gone lingers in the "Add a field" picker forever with no way to be rid of it.
   * Surfacing exactly the unreferenced ones is what makes removal safe to offer: anything
   * still in use is, by construction, not in this list.
   */
  async listUnusedFieldDefs(): Promise<FieldDef[]> {
    const rows = await this.driver.query<FieldDefRow>(
      `SELECT * FROM field_defs fd
       WHERE NOT EXISTS (SELECT 1 FROM category_fields      WHERE def_id = fd.id)
         AND NOT EXISTS (SELECT 1 FROM location_field_values WHERE def_id = fd.id)
         AND NOT EXISTS (SELECT 1 FROM item_field_values     WHERE def_id = fd.id)
       ORDER BY name COLLATE NOCASE ASC;`,
    );
    return rows.map(rowToFieldDef);
  }

  /**
   * Delete an **unused** dictionary definition (see {@link listUnusedFieldDefs}).
   *
   * The unused test is re-applied here rather than trusted from the caller's list, which may
   * be seconds stale — a peer's sync or another tab could have given the definition a user in
   * the meantime, and deleting it then would cascade away a value someone had just set.
   *
   * Crucially the test lives **inside the DELETE's own WHERE clause**, not in a preceding
   * query: a separate check would only narrow the race, since a reference can still arrive
   * between the check resolving and the delete running. As one statement, SQLite evaluates
   * the predicate and the deletion together, so a definition that has acquired a reference
   * matches nothing and survives. No child tombstones are needed precisely because a row
   * that passes the predicate has no children.
   */
  async deleteUnusedFieldDef(defId: string): Promise<boolean> {
    this.assertPermission('categories:write');
    this.assertWritable();
    await this.driver.transaction([
      {
        sql: `DELETE FROM field_defs
              WHERE id = ?
                AND NOT EXISTS (SELECT 1 FROM category_fields       WHERE def_id = field_defs.id)
                AND NOT EXISTS (SELECT 1 FROM location_field_values WHERE def_id = field_defs.id)
                AND NOT EXISTS (SELECT 1 FROM item_field_values     WHERE def_id = field_defs.id);`,
        params: [defId],
      },
      // Tombstoned on the same condition, so a definition the predicate spared is never
      // marked deleted for peers (a tombstone without the deletion would strand it).
      {
        sql: `INSERT OR REPLACE INTO tombstones (table_name, id)
              SELECT 'field_defs', ?
              WHERE NOT EXISTS (SELECT 1 FROM field_defs WHERE id = ?);`,
        params: [defId, defId],
      },
    ]);

    // Report what actually happened by reading back, rather than assuming success: the
    // caller distinguishes "removed" from "left alone because it is in use after all".
    const survivor = await this.driver.queryOne<{ id: string }>('SELECT id FROM field_defs WHERE id = ?;', [
      defId,
    ]);
    return survivor === undefined;
  }

  /**
   * The dictionary definition holding `name`, or `undefined` when the name is free.
   * `excludeDefId` skips one definition — the row a rename is moving, which must not
   * clash with itself.
   *
   * **Matched in JS, not SQL, and that is the point (issue #343).** The obvious
   * `WHERE name = ? COLLATE NOCASE` folds ASCII A–Z only, so `Café` would not find
   * `CAFÉ` and the two would fork the definition in exactly the way the table's unique
   * index exists to prevent — see `lib/name-fold` for why the collation can't be widened.
   * The dictionary is a user-scale list of field names (bounded by how many fields a
   * person has defined, not by the item count), so reading it whole is one small query.
   *
   * Ordered so the answer is stable: a database written before this fold existed can
   * already hold both `Größe` and `GRÖSSE`, and which of the two an unordered read
   * happened to return first would otherwise decide which definition a field joins.
   */
  private async findFieldDefByName(name: string, excludeDefId?: string): Promise<FieldDefRow | undefined> {
    const rows = await this.driver.query<FieldDefRow>('SELECT * FROM field_defs ORDER BY name, id;');
    const needle = foldName(name);
    return rows.find((row) => row.id !== excludeDefId && foldName(row.name) === needle);
  }

  /**
   * Resolve a dictionary definition by name, creating it when absent (issue #97).
   *
   * Reuse by name is the mechanism that keeps the dictionary from fragmenting: two
   * categories that both declare "Manufacturer" must land on the *same* definition, or a
   * location's inheritable Manufacturer would reach items in one category and silently
   * miss the other. Matching is case-insensitive — see {@link findFieldDefByName}.
   *
   * A name that already exists with a **different** field type is rejected rather than
   * retyping the shared definition out from under every other category and location using
   * it — that would reinterpret stored values app-wide as a side effect of adding a field.
   */
  private async resolveFieldDef(
    input: {
      name: string;
      fieldType: FieldType;
      options: string | null;
      description?: string | null;
      dueLeadDays?: number | null;
      unit?: string | null;
      minValue?: number | null;
      maxValue?: number | null;
      precision?: number | null;
      prominence?: string | null;
    },
    statements: SqlStatement[],
  ): Promise<string> {
    const existing = await this.findFieldDefByName(input.name);
    if (existing) {
      if (existing.field_type !== input.fieldType) {
        throw new DbError(
          'SQLITE_CONSTRAINT',
          `The field "${existing.name}" already exists as a ${existing.field_type} field. ` +
            `Rename this field, or change the existing one's type, rather than defining it twice.`,
        );
      }
      // Reuse leaves the definition's identity alone — a second category declaring
      // "Manufacturer" must not overwrite the note someone wrote on it. The attributes that
      // say what the field *means* are the exception, and only in the *setting* direction: a
      // caller supplying a due-date opt-in, a unit or a bound is stating what the field is, so
      // it applies to the shared definition, while omitting one never clears what the first
      // category is already relying on.
      //
      // Supplying one end of a range against a definition that already holds the other can
      // invert it, so the pair is judged on its *effective* values rather than on the input
      // alone — otherwise reuse would be the one way past the ordering rule.
      this.assertRangeOrdered(input.minValue ?? existing.min_value, input.maxValue ?? existing.max_value);
      const sets: string[] = [];
      const params: SqlValue[] = [];
      const applyOnReuse = (column: string, incoming: SqlValue | undefined, current: SqlValue) => {
        if (incoming != null && incoming !== current) {
          sets.push(`${column} = ?`);
          params.push(incoming);
        }
      };
      applyOnReuse('due_lead_days', input.dueLeadDays, existing.due_lead_days);
      applyOnReuse('unit', input.unit, existing.unit);
      applyOnReuse('min_value', input.minValue, existing.min_value);
      applyOnReuse('max_value', input.maxValue, existing.max_value);
      // `applyOnReuse` tests `!= null` rather than falsiness, which is what makes `precision = 0`
      // reach a shared definition: "whole numbers only" is the setting this exists for, and a
      // truthiness test would be the one value it silently dropped.
      applyOnReuse('precision', input.precision, existing.precision);
      // Prominence follows the same set-but-never-clear rule, and for the same reason read the
      // other way round: adding a shared field to a second category must not quietly demote it
      // in the first. `serialiseFieldDefProminence` has already folded "ordinary" to null, so an
      // unticked box arrives here as an omission rather than as a demotion.
      applyOnReuse('prominence', input.prominence, existing.prominence);
      if (sets.length > 0) {
        statements.push({
          sql: `UPDATE field_defs SET ${sets.join(', ')} WHERE id = ?;`,
          params: [...params, existing.id],
        });
      }
      return existing.id;
    }
    const id = crypto.randomUUID();
    statements.push({
      sql: `INSERT INTO field_defs
              (id, name, field_type, options, description, due_lead_days, unit, min_value, max_value,
               precision, prominence)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);`,
      params: [
        id,
        input.name,
        input.fieldType,
        input.options,
        input.description ?? null,
        input.dueLeadDays ?? null,
        input.unit ?? null,
        input.minValue ?? null,
        input.maxValue ?? null,
        input.precision ?? null,
        input.prominence ?? null,
      ],
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
    this.assertPermission('categories:write');
    this.assertWritable();
    await this.requireCategory(categoryId);
    const { name, fieldType, options } = this.validateFieldInput(input);
    const dueLeadDays = this.validateDueLeadDays(input.dueLeadDays, fieldType);
    const unit = this.validateUnit(input.unit, fieldType);
    const minValue = this.validateNumberBound(input.minValue, fieldType, 'minimum');
    const maxValue = this.validateNumberBound(input.maxValue, fieldType, 'maximum');
    const precision = this.validatePrecision(input.precision, fieldType);
    this.assertRangeOrdered(minValue, maxValue);
    // No validation beyond canonicalisation: prominence is presentational and applies to every
    // field type, so there is no type to check it against and no bound to clamp it to.
    const prominence = serialiseFieldDefProminence(input.prominence);

    // Definition creation and the category's use of it land in one transaction, so a
    // failure can never leave an orphan definition behind.
    const statements: SqlStatement[] = [];
    const defId = await this.resolveFieldDef(
      {
        name,
        fieldType,
        options,
        description: input.description,
        dueLeadDays,
        unit,
        minValue,
        maxValue,
        precision,
        prominence,
      },
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
    this.assertPermission('categories:write');
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
      // A rename onto a name another definition already holds fragments the dictionary;
      // report it in the app's voice rather than as a raw SQLite error. Named back with the
      // *existing* spelling, so a clash that differs only in case reads as the collision it is.
      const clash = await this.findFieldDefByName(validated.name, existing.defId);
      if (clash) {
        throw new DbError(
          'SQLITE_CONSTRAINT',
          `A field named "${clash.name}" already exists. Field names identify a field across ` +
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
      // Retyping away from DATE takes the due-date opt-in with it. The table CHECK forbids the
      // pair outright, so without this the user's edit would fail on a constraint they cannot
      // see; clearing it here makes "this is no longer a date" mean what it says.
      if (validated.fieldType !== 'DATE' && existing.dueLeadDays != null && input.dueLeadDays === undefined) {
        defSets.push('due_lead_days = ?');
        defParams.push(null);
      }
      // Retyping away from NUMBER takes the unit, the range and the precision with it, for
      // exactly the same reason: the CHECK forbids any of them on another type, so leaving one
      // behind would fail the user's edit on a constraint they cannot see. Each is skipped when
      // the caller set it in the same edit, so the explicit set below is not overwritten — and so
      // the column never appears twice in one `SET`.
      if (validated.fieldType !== 'NUMBER') {
        if (existing.unit != null && input.unit === undefined) {
          defSets.push('unit = ?');
          defParams.push(null);
        }
        if (existing.minValue != null && input.minValue === undefined) {
          defSets.push('min_value = ?');
          defParams.push(null);
        }
        if (existing.maxValue != null && input.maxValue === undefined) {
          defSets.push('max_value = ?');
          defParams.push(null);
        }
        // `!= null` again, not falsiness: a field set to whole numbers holds `0`, and testing
        // truthiness here would leave that behind on a retype for the CHECK to reject.
        if (existing.precision != null && input.precision === undefined) {
          defSets.push('precision = ?');
          defParams.push(null);
        }
      }
    }
    if (input.description !== undefined) {
      defSets.push('description = ?');
      defParams.push(input.description);
    }
    if (input.dueLeadDays !== undefined) {
      // Validated against the *effective* type, so opting in while retyping to DATE in the
      // same edit is accepted and opting in on a non-date is refused with a readable message.
      defSets.push('due_lead_days = ?');
      defParams.push(this.validateDueLeadDays(input.dueLeadDays, validated.fieldType));
    }
    // The unit, range and precision are validated against the *effective* type too, so setting
    // one while retyping to Number in the same edit is accepted and setting one on any other type
    // is refused with a readable message.
    if (input.unit !== undefined) {
      defSets.push('unit = ?');
      defParams.push(this.validateUnit(input.unit, validated.fieldType));
    }
    if (input.minValue !== undefined) {
      defSets.push('min_value = ?');
      defParams.push(this.validateNumberBound(input.minValue, validated.fieldType, 'minimum'));
    }
    if (input.maxValue !== undefined) {
      defSets.push('max_value = ?');
      defParams.push(this.validateNumberBound(input.maxValue, validated.fieldType, 'maximum'));
    }
    if (input.precision !== undefined) {
      defSets.push('precision = ?');
      defParams.push(this.validatePrecision(input.precision, validated.fieldType));
    }
    // Prominence is not gated on the field type and so is never cleared by a retype — any type
    // can be the field that matters most. Canonicalised rather than validated: an unrecognised
    // mode from a newer peer is stored verbatim and read as ordinary, exactly as the category
    // axis does, because failing a write over a display preference is the worse outcome.
    if (input.prominence !== undefined) {
      defSets.push('prominence = ?');
      defParams.push(serialiseFieldDefProminence(input.prominence));
    }
    // The ordering rule judges the pair the row will actually hold, not the input: either end
    // may be left untouched by this edit, so comparing only what was supplied would let a
    // one-sided edit invert a range whose other end the definition already defines.
    this.assertRangeOrdered(
      input.minValue !== undefined
        ? input.minValue
        : validated.fieldType === 'NUMBER'
          ? existing.minValue
          : null,
      input.maxValue !== undefined
        ? input.maxValue
        : validated.fieldType === 'NUMBER'
          ? existing.maxValue
          : null,
    );
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
    this.assertPermission('categories:write');
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
         ORDER BY ${FIELD_PROMINENCE_RANK}, cf.position ASC, fd.name COLLATE NOCASE ASC;`,
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
    this.assertPermission('items:write');
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
   * The custom-field values a location holds, joined to their dictionary definitions: key
   * definitions first (W1d), then field name. Includes non-inheritable rows: the location's
   * editor shows every value it has set, with inheritability as a per-row toggle.
   *
   * A location's values have no `position` of their own — they belong to no category — so the
   * prominence rank is the *only* axis that can lift one of them above alphabetical order. That
   * is a large part of why the rank lives on the definition rather than beside a category's policy.
   */
  async listLocationFieldValues(locationId: string): Promise<LocationFieldValue[]> {
    const rows = await this.driver.query<
      LocationFieldValueRow & {
        name: string;
        field_type: FieldType;
        options: string | null;
        description: string | null;
        unit: string | null;
        min_value: number | null;
        max_value: number | null;
        precision: number | null;
        prominence: string | null;
      }
    >(
      `SELECT lfv.*, fd.name, fd.field_type, fd.options, fd.description,
              fd.unit, fd.min_value, fd.max_value, fd.precision, fd.prominence
       FROM location_field_values lfv
       JOIN field_defs fd ON fd.id = lfv.def_id
       WHERE lfv.location_id = ?
       ORDER BY ${FIELD_PROMINENCE_RANK}, fd.name COLLATE NOCASE ASC;`,
      [locationId],
    );
    return rows.map(rowToLocationFieldValue);
  }

  /**
   * Every location's field values as one searchable text blob per location, so the sidebar's
   * free-text search can find a place by something recorded *about* it and not only by its
   * ancestry path (issue #617, `N2`).
   *
   * Text rather than rows because that is all the caller does with it, and because it is what
   * keeps the read small: the alternative — hydrating every location's full `LocationFieldValue`
   * list to concatenate it in the UI — pulls the dictionary join and every unused column across
   * the worker boundary for a haystack.
   *
   * `IMAGE` values are excluded in **SQL**, not afterwards: the stored value *is* the picture (a
   * base64 `data:` URL), so a vault with a few image fields would otherwise ship megabytes of
   * base64 into a search index where it can only produce nonsense matches. Blank values are
   * dropped for the same reason they contribute nothing.
   *
   * Bounded by the location × field count — the same "physical hierarchy, not the 100k+ item
   * set" reasoning as {@link LocationRepository.listAll} — so it reads whole rather than paging.
   */
  async listLocationFieldSearchText(): Promise<Map<string, string>> {
    const rows = await this.driver.query<{ location_id: string; value: string }>(
      `SELECT lfv.location_id, lfv.value
       FROM location_field_values lfv
       JOIN field_defs fd ON fd.id = lfv.def_id
       WHERE fd.field_type <> 'IMAGE'
         AND lfv.value IS NOT NULL
         AND TRIM(lfv.value) <> ''
       ORDER BY lfv.location_id ASC, fd.name COLLATE NOCASE ASC;`,
    );
    const byLocation = new Map<string, string>();
    for (const row of rows) {
      const existing = byLocation.get(row.location_id);
      // Newline-joined so no search term — which is split on whitespace — can straddle two
      // values and match text the location does not actually hold.
      byLocation.set(row.location_id, existing === undefined ? row.value : `${existing}\n${row.value}`);
    }
    return byLocation;
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
    this.assertPermission('locations:write');
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
    this.assertPermission('locations:write');
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

  /**
   * Validate a `dueLeadDays` opt-in against the field type it is being set on, returning the
   * value to store. Only a `DATE` can be a deadline, and the notice period is a whole number
   * of calendar days within {@link FIELD_DUE_LEAD_DAYS_MIN}–{@link FIELD_DUE_LEAD_DAYS_MAX}.
   *
   * Reported in the app's voice here rather than left to the table CHECK, which would surface
   * as a raw SQLite constraint failure with no indication of which rule was broken.
   */
  private validateDueLeadDays(value: number | null | undefined, fieldType: FieldType): number | null {
    if (value == null) return null;
    if (fieldType !== 'DATE') {
      throw new DbError(
        'SQLITE_CONSTRAINT',
        'Only a Date field can be used as a due date. Change the field to Date first, or clear the due-date setting.',
      );
    }
    if (!Number.isInteger(value) || value < FIELD_DUE_LEAD_DAYS_MIN || value > FIELD_DUE_LEAD_DAYS_MAX) {
      throw new DbError(
        'SQLITE_CONSTRAINT',
        `A due date's notice period must be a whole number of days from ${FIELD_DUE_LEAD_DAYS_MIN} to ${FIELD_DUE_LEAD_DAYS_MAX}.`,
      );
    }
    return value;
  }

  /**
   * Validate a `unit` against the field type it is being set on, returning the value to store
   * (W1b). Only a `NUMBER` carries a unit, and a unit is a symbol rather than a sentence — see
   * {@link FIELD_UNIT_MAX_LENGTH}.
   *
   * A blank unit folds to `null` rather than being stored as `''`, so "no unit" has exactly one
   * spelling — the same discipline `validateFieldValue` applies to a cleared value. Reported in
   * the app's voice here rather than left to the table CHECK, which would surface as a raw
   * SQLite constraint failure naming no rule.
   */
  private validateUnit(value: string | null | undefined, fieldType: FieldType): string | null {
    if (value == null) return null;
    const unit = value.trim();
    if (unit.length === 0) return null;
    if (fieldType !== 'NUMBER') {
      throw new DbError(
        'SQLITE_CONSTRAINT',
        'Only a Number field can carry a unit. Change the field to Number first, or clear the unit.',
      );
    }
    if (unit.length > FIELD_UNIT_MAX_LENGTH) {
      throw new DbError(
        'SQLITE_CONSTRAINT',
        `A unit can be at most ${FIELD_UNIT_MAX_LENGTH} characters — it is a symbol such as "mm" or "kg", not a description.`,
      );
    }
    return unit;
  }

  /**
   * Validate one end of a `NUMBER` field's range against the field type it is being set on,
   * returning the value to store (W1c). `label` names the end for the error message.
   *
   * Either end may be `null` — that means *unbounded on that side*, not "unset half a setting"
   * — so this validates each independently and {@link assertRangeOrdered} judges the pair.
   */
  private validateNumberBound(
    value: number | null | undefined,
    fieldType: FieldType,
    label: 'minimum' | 'maximum',
  ): number | null {
    if (value == null) return null;
    if (fieldType !== 'NUMBER') {
      throw new DbError(
        'SQLITE_CONSTRAINT',
        `Only a Number field can have a ${label}. Change the field to Number first, or clear the range.`,
      );
    }
    if (!Number.isFinite(value) || Math.abs(value) > FIELD_NUMBER_BOUND_LIMIT) {
      throw new DbError(
        'SQLITE_CONSTRAINT',
        `A field's ${label} must be a number between -${FIELD_NUMBER_BOUND_LIMIT} and ${FIELD_NUMBER_BOUND_LIMIT}.`,
      );
    }
    return value;
  }

  /**
   * Validate a `precision` against the field type it is being set on, returning the value to
   * store (W1e). Only a `NUMBER` is written to a number of decimal places, and the count is a
   * whole number within {@link FIELD_PRECISION_MIN}–{@link FIELD_PRECISION_MAX}.
   *
   * `null` is the only spelling of "as entered". `0` is a genuine setting — whole numbers only —
   * so this guards on `== null` rather than falsiness, which is the trap this whole attribute
   * invites: every other optional number here is meaningless at zero, and this one is not.
   *
   * Reported in the app's voice rather than left to the table CHECK, which would surface as a raw
   * SQLite constraint failure naming no rule.
   */
  private validatePrecision(value: number | null | undefined, fieldType: FieldType): number | null {
    if (value == null) return null;
    if (fieldType !== 'NUMBER') {
      throw new DbError(
        'SQLITE_CONSTRAINT',
        'Only a Number field can be given a number of decimal places. Change the field to Number ' +
          'first, or clear the decimal places.',
      );
    }
    if (!Number.isInteger(value) || value < FIELD_PRECISION_MIN || value > FIELD_PRECISION_MAX) {
      throw new DbError(
        'SQLITE_CONSTRAINT',
        `Decimal places must be a whole number from ${FIELD_PRECISION_MIN} to ${FIELD_PRECISION_MAX}.`,
      );
    }
    return value;
  }

  /**
   * Refuse an inverted range. A minimum above its maximum admits no value at all, so it does
   * not describe a strict field but an unusable one — every entry would fail, with nothing on
   * the item editor to explain why. Equal bounds are allowed: they mean "exactly this".
   */
  private assertRangeOrdered(minValue: number | null, maxValue: number | null): void {
    if (minValue != null && maxValue != null && minValue > maxValue) {
      throw new DbError(
        'SQLITE_CONSTRAINT',
        `A field's minimum (${minValue}) cannot be above its maximum (${maxValue}) — no value could satisfy that range.`,
      );
    }
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

function toWithFieldCount(row: CategoryCountRow): CategoryWithFieldCount {
  return { ...rowToCategory(row), fieldCount: Number(row.field_count) };
}
