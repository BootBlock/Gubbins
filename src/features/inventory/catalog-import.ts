/**
 * Bulk catalog CSV import (spec §2 "Spreadsheet onboarding", Phase 67).
 *
 * Parses a user-supplied CSV, maps its columns to {@link CreateItemInput} /
 * {@link UpdateItemInput} fields, validates each row with Zod, and returns a
 * **dry-run plan** that the caller can preview before committing. The plan
 * partitions rows into creates (no matching item found), updates (a match found
 * by the chosen key), and errors (invalid rows — never thrown, always collected).
 *
 * The CSV codec is re-used from {@link parseCsv} in `../projects/bom-import`
 * (same RFC-4180-safe parser, no new dependency). The apply helper runs the plan
 * through the existing {@link ItemRepository} `create`/`update` public methods —
 * no new SQL, no new columns.
 *
 * Kept free of React and the DOM for instant unit-test execution.
 */
import { z } from 'zod';
import { parseCsv } from '../projects/bom-import';
import { validateFieldValue } from './custom-fields';
import { TRACKING_MODES, CONDITIONS, UNASSIGNED_LOCATION_ID } from '@/db/repositories/constants';
import type {
  CategoryField,
  CreateItemInput,
  UpdateItemInput,
  Item,
} from '@/db/repositories/types';

// Re-export so callers import from one place.
export { parseCsv };

// ---------------------------------------------------------------------------
// Column-mapping model
// ---------------------------------------------------------------------------

/**
 * The logical catalog field names the importer understands. Each maps to one
 * column in the user's CSV (after normalisation). Fields that don't appear in a
 * given import are silently skipped (undefined = leave unchanged on update, or
 * use the repo default on create).
 */
export type CatalogField =
  | 'name'
  | 'description'
  | 'sku'
  | 'quantity'
  | 'locationId'
  | 'categoryId'
  | 'trackingMode'
  | 'mpn'
  | 'manufacturer'
  | 'unitCost'
  | 'batchNumber'
  | 'lotNumber'
  | 'condition'
  | 'reorderPoint'
  | 'reorderQty';

/** All recognised logical field names (used for UI pickers). */
export const CATALOG_FIELDS: readonly CatalogField[] = [
  'name',
  'description',
  'sku',
  'quantity',
  'locationId',
  'categoryId',
  'trackingMode',
  'mpn',
  'manufacturer',
  'unitCost',
  'batchNumber',
  'lotNumber',
  'condition',
  'reorderPoint',
  'reorderQty',
];

/** Human-readable label for each field (used in the import wizard UI). */
export const CATALOG_FIELD_LABELS: Record<CatalogField, string> = {
  name: 'Name',
  description: 'Description',
  sku: 'SKU / MPN',
  quantity: 'Quantity',
  locationId: 'Location ID',
  categoryId: 'Category ID',
  trackingMode: 'Tracking mode',
  mpn: 'Manufacturer part number',
  manufacturer: 'Manufacturer',
  unitCost: 'Unit cost',
  batchNumber: 'Batch number',
  lotNumber: 'Lot number',
  condition: 'Condition',
  reorderPoint: 'Reorder point',
  reorderQty: 'Reorder quantity',
};

/**
 * A column that targets a category **custom field** (Phase 72) rather than a core
 * catalog field. The value is validated and canonically coerced through the
 * Phase-70 `validateFieldValue` seam and persisted via
 * `CategoryRepository.setItemFieldValues` (no second write path). Identified by the
 * field-definition id; resolution from a header to this target is by field name/key.
 */
export interface CustomFieldTarget {
  readonly fieldId: string;
}

/** Narrowing helper: is a mapping entry a custom-field target? */
export function isCustomFieldTarget(
  entry: CatalogField | CustomFieldTarget | null,
): entry is CustomFieldTarget {
  return entry !== null && typeof entry === 'object' && 'fieldId' in entry;
}

/**
 * Maps each CSV header (column index → logical field, or a {@link CustomFieldTarget}
 * for a category custom field). A `null` entry means the column is unmapped (ignored).
 */
export type ColumnMapping = ReadonlyArray<CatalogField | CustomFieldTarget | null>;

/**
 * The field whose value is used to decide create-vs-update:
 * - `'name'`  — match existing items by their name (case-sensitive).
 * - `'sku'`   — match by SKU/MPN (the `mpn` column on the item record).
 */
export type MatchKey = 'name' | 'sku';

// ---------------------------------------------------------------------------
// Automatic header → field inference
// ---------------------------------------------------------------------------

/** Normalise a header cell: lowercase + strip non-alphanumeric characters. */
function headerKey(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/** Synonym map (normalised key → logical field) for auto-detection. */
const HEADER_SYNONYMS: ReadonlyArray<readonly [string, CatalogField]> = [
  ['name', 'name'],
  ['itemname', 'name'],
  ['title', 'name'],
  ['description', 'description'],
  ['desc', 'description'],
  ['sku', 'sku'],
  ['mpn', 'sku'],
  ['manufacturerpartnumber', 'sku'],
  ['partnumber', 'sku'],
  ['quantity', 'quantity'],
  ['qty', 'quantity'],
  ['count', 'quantity'],
  ['stock', 'quantity'],
  ['locationid', 'locationId'],
  ['location', 'locationId'],
  ['categoryid', 'categoryId'],
  ['category', 'categoryId'],
  ['trackingmode', 'trackingMode'],
  ['tracking', 'trackingMode'],
  ['type', 'trackingMode'],
  ['manufacturer', 'manufacturer'],
  ['mfr', 'manufacturer'],
  ['unitcost', 'unitCost'],
  ['cost', 'unitCost'],
  ['price', 'unitCost'],
  ['batchnumber', 'batchNumber'],
  ['batch', 'batchNumber'],
  ['lotnumber', 'lotNumber'],
  ['lot', 'lotNumber'],
  ['condition', 'condition'],
  ['reorderpoint', 'reorderPoint'],
  ['reorderqty', 'reorderQty'],
  ['reorderquantity', 'reorderQty'],
];

/**
 * Infer a {@link ColumnMapping} from a CSV header row. Core catalog synonyms win
 * first; a header that matches no core synonym is then matched against the supplied
 * category **custom-field** definitions by normalised name (or exact field id), so a
 * column like `Resistance` targets that category field (Phase 72). Unrecognised
 * columns map to `null`. Each core field and each custom field is assigned at most
 * once (first header wins).
 */
export function inferColumnMapping(
  headers: readonly string[],
  customFields: readonly CategoryField[] = [],
): ColumnMapping {
  const assigned = new Set<CatalogField>();
  const assignedFieldIds = new Set<string>();
  // Normalised-name → field id, plus the raw id itself, for custom-field resolution.
  // First definition wins on a name clash (mirrors the core "first header wins").
  const fieldByKey = new Map<string, string>();
  for (const def of customFields) {
    const nameKey = headerKey(def.name);
    if (nameKey.length > 0 && !fieldByKey.has(nameKey)) fieldByKey.set(nameKey, def.id);
    if (!fieldByKey.has(def.id)) fieldByKey.set(def.id, def.id);
  }

  return headers.map((h) => {
    const key = headerKey(h);
    for (const [synonym, field] of HEADER_SYNONYMS) {
      if (synonym === key && !assigned.has(field)) {
        assigned.add(field);
        return field;
      }
    }
    // No core match — try a custom field. Match on the normalised header key or the
    // raw (un-normalised) header, the latter so a UUID field id used as a header
    // resolves even though normalisation would strip its hyphens.
    const fieldId = fieldByKey.get(key) ?? fieldByKey.get(h.trim());
    if (fieldId !== undefined && !assignedFieldIds.has(fieldId)) {
      assignedFieldIds.add(fieldId);
      return { fieldId };
    }
    return null;
  });
}

// ---------------------------------------------------------------------------
// Per-row Zod validation
// ---------------------------------------------------------------------------

const trackingModeSchema = z.enum(TRACKING_MODES).optional();
const conditionSchema = z.enum(CONDITIONS).optional().nullable();

const catalogRowSchema = z.object({
  name: z.string().trim().min(1, 'Name is required.').optional(),
  description: z.string().trim().optional().nullable(),
  sku: z.string().trim().optional().nullable(),
  quantity: z.number().int('Quantity must be a whole number.').min(0, 'Quantity cannot be negative.').optional(),
  locationId: z.string().trim().optional(),
  categoryId: z.string().trim().optional().nullable(),
  trackingMode: trackingModeSchema,
  mpn: z.string().trim().optional().nullable(),
  manufacturer: z.string().trim().optional().nullable(),
  unitCost: z.number().min(0, 'Unit cost cannot be negative.').optional().nullable(),
  batchNumber: z.string().trim().optional().nullable(),
  lotNumber: z.string().trim().optional().nullable(),
  condition: conditionSchema,
  reorderPoint: z.number().int().min(0).optional().nullable(),
  reorderQty: z.number().int().min(0).optional().nullable(),
});

type CatalogRowData = z.infer<typeof catalogRowSchema>;

// ---------------------------------------------------------------------------
// Raw cell extraction helpers
// ---------------------------------------------------------------------------

function rawCell(row: readonly string[], index: number | null | undefined): string | null {
  if (index === null || index === undefined) return null;
  const value = (row[index] ?? '').trim();
  return value.length > 0 ? value : null;
}

function parseOptionalNumber(text: string | null): number | undefined | null {
  if (text === null) return undefined;
  const n = Number(text);
  return Number.isFinite(n) ? n : undefined;
}

function parseOptionalInt(text: string | null): number | undefined | null {
  if (text === null) return undefined;
  const n = Number.parseInt(text, 10);
  return Number.isFinite(n) ? n : undefined;
}

/** The raw cells of one CSV data row, partitioned into core + custom-field columns. */
interface ExtractedRow {
  /** Core catalog fields keyed by logical name (first mapped column wins). */
  readonly core: Partial<Record<CatalogField, string | null>>;
  /** Custom-field raw values keyed by field-definition id (first column wins). */
  readonly custom: Record<string, string | null>;
}

/**
 * Extract one CSV data row using the column mapping. Core fields return `undefined`
 * for unmapped / absent columns so the Zod schema can distinguish "not supplied"
 * from "supplied as empty"; custom-field columns are collected separately keyed by
 * field-definition id, to be validated through the Phase-70 seam.
 */
function extractRow(row: readonly string[], mapping: ColumnMapping): ExtractedRow {
  const core: Partial<Record<CatalogField, string | null>> = {};
  const custom: Record<string, string | null> = {};
  for (let i = 0; i < mapping.length; i += 1) {
    const target = mapping[i];
    if (target === null || target === undefined) continue;
    if (isCustomFieldTarget(target)) {
      if (target.fieldId in custom) continue; // first column for each field wins
      custom[target.fieldId] = rawCell(row, i);
      continue;
    }
    if (target in core) continue; // first column for each logical field wins
    core[target] = rawCell(row, i);
  }
  return { core, custom };
}

/**
 * Coerce a raw string-map into a typed {@link CatalogRowData} for Zod parsing.
 * Numeric fields are converted from strings here so Zod receives the right types.
 */
function coerceRow(raw: Partial<Record<CatalogField, string | null>>): CatalogRowData {
  return {
    name: raw.name ?? undefined,
    description: raw.description,
    // 'sku' in the column map resolves to the `mpn` field on the item — the SKU
    // concept maps directly to the manufacturer part number.
    sku: raw.sku,
    quantity: parseOptionalInt(raw.quantity ?? null) ?? undefined,
    locationId: raw.locationId ?? undefined,
    categoryId: raw.categoryId,
    trackingMode: (raw.trackingMode ?? undefined) as CatalogRowData['trackingMode'],
    mpn: raw.mpn,
    manufacturer: raw.manufacturer,
    unitCost: parseOptionalNumber(raw.unitCost ?? null),
    batchNumber: raw.batchNumber,
    lotNumber: raw.lotNumber,
    condition: (raw.condition ?? undefined) as CatalogRowData['condition'],
    reorderPoint: parseOptionalInt(raw.reorderPoint ?? null),
    reorderQty: parseOptionalInt(raw.reorderQty ?? null),
  };
}

// ---------------------------------------------------------------------------
// Dry-run plan types
// ---------------------------------------------------------------------------

/**
 * Per-item custom-field values, keyed by field-definition id, already validated and
 * canonically coerced through the Phase-70 `validateFieldValue` seam (`null` clears
 * the value). Applied via `CategoryRepository.setItemFieldValues` (no second write
 * path). Absent / empty when the import maps no custom-field columns.
 */
export type CustomFieldValues = Readonly<Record<string, string | null>>;

/** A fully-validated row destined for {@link ItemRepository.create}. */
export interface CatalogCreate {
  /** 1-based index of the source CSV data row (not counting the header). */
  readonly sourceRow: number;
  readonly input: CreateItemInput;
  /** Coerced custom-field values to persist after the item is created. */
  readonly fieldValues?: CustomFieldValues;
}

/** A fully-validated row destined for {@link ItemRepository.update}. */
export interface CatalogUpdate {
  readonly sourceRow: number;
  /** The id of the matched existing item. */
  readonly itemId: string;
  readonly input: UpdateItemInput;
  /** Coerced custom-field values to persist after the item is updated. */
  readonly fieldValues?: CustomFieldValues;
}

/** A row that failed validation or had a duplicate match key (never thrown). */
export interface CatalogError {
  readonly sourceRow: number;
  readonly message: string;
}

/** The complete output of a dry-run parse: review before applying. */
export interface CatalogImportPlan {
  readonly create: readonly CatalogCreate[];
  readonly update: readonly CatalogUpdate[];
  readonly errors: readonly CatalogError[];
}

// ---------------------------------------------------------------------------
// Convert validated row → CreateItemInput / UpdateItemInput
// ---------------------------------------------------------------------------

function toCreateInput(data: CatalogRowData): CreateItemInput {
  const mpn = data.sku ?? data.mpn ?? null;
  return {
    name: data.name!, // guaranteed non-empty by Zod
    description: data.description ?? null,
    locationId: data.locationId ?? UNASSIGNED_LOCATION_ID,
    categoryId: data.categoryId ?? null,
    trackingMode: data.trackingMode ?? 'DISCRETE',
    quantity: data.quantity ?? 0,
    mpn,
    manufacturer: data.manufacturer ?? null,
    unitCost: data.unitCost ?? null,
    batchNumber: data.batchNumber ?? null,
    lotNumber: data.lotNumber ?? null,
    condition: data.condition ?? null,
    reorderPoint: data.reorderPoint ?? null,
    reorderQty: data.reorderQty ?? null,
  };
}

function toUpdateInput(data: CatalogRowData): UpdateItemInput {
  const mpn = data.sku ?? data.mpn;
  const result: UpdateItemInput = {};
  if (data.name !== undefined) Object.assign(result, { name: data.name });
  if (data.description !== undefined) Object.assign(result, { description: data.description });
  if (mpn !== undefined) Object.assign(result, { mpn: mpn ?? null });
  if (data.manufacturer !== undefined) Object.assign(result, { manufacturer: data.manufacturer });
  if (data.unitCost !== undefined) Object.assign(result, { unitCost: data.unitCost ?? null });
  if (data.batchNumber !== undefined) Object.assign(result, { batchNumber: data.batchNumber });
  if (data.lotNumber !== undefined) Object.assign(result, { lotNumber: data.lotNumber });
  if (data.condition !== undefined) Object.assign(result, { condition: data.condition ?? null });
  if (data.reorderPoint !== undefined) Object.assign(result, { reorderPoint: data.reorderPoint ?? null });
  if (data.reorderQty !== undefined) Object.assign(result, { reorderQty: data.reorderQty ?? null });
  if (data.categoryId !== undefined) Object.assign(result, { categoryId: data.categoryId ?? null });
  return result;
}

// ---------------------------------------------------------------------------
// Custom-field column resolution (Phase 72)
// ---------------------------------------------------------------------------

/**
 * Validate + canonically coerce a row's custom-field columns through the Phase-70
 * `validateFieldValue` seam. Returns the coerced values keyed by field id (incl.
 * `null` to clear a field), or `null` when ANY column is invalid — in which case the
 * error is appended to `errors` (collected, never thrown) and the caller skips the
 * row. An empty result (`{}`) means the row mapped no custom-field columns.
 */
function resolveCustomFieldValues(
  rawCustom: Readonly<Record<string, string | null>>,
  defById: ReadonlyMap<string, CategoryField>,
  sourceRow: number,
  errors: CatalogError[],
): Record<string, string | null> | null {
  const values: Record<string, string | null> = {};
  for (const [fieldId, rawValue] of Object.entries(rawCustom)) {
    const def = defById.get(fieldId);
    if (def === undefined) {
      // The mapping referenced a field id with no matching definition.
      errors.push({ sourceRow, message: `Unknown custom field "${fieldId}".` });
      return null;
    }
    const result = validateFieldValue(def, rawValue);
    if (!result.ok) {
      errors.push({ sourceRow, message: result.error });
      return null;
    }
    values[fieldId] = result.value;
  }
  return values;
}

/**
 * Spread helper: attach `fieldValues` to a plan entry only when at least one
 * custom-field column was mapped, so existing entries (and their tests) keep their
 * exact shape when no custom fields are in play.
 */
function withFieldValues(
  values: Record<string, string | null>,
): { fieldValues?: CustomFieldValues } {
  return Object.keys(values).length > 0 ? { fieldValues: values } : {};
}

// ---------------------------------------------------------------------------
// Dry-run plan builder
// ---------------------------------------------------------------------------

/**
 * Options for {@link buildCatalogImportPlan}.
 */
export interface BuildPlanOptions {
  /**
   * The field used to decide create-vs-update.
   * - `'name'` — match existing items by their name.
   * - `'sku'`  — match by SKU/MPN (`mpn` on the item record).
   * Defaults to `'name'`.
   */
  readonly matchKey?: MatchKey;
  /**
   * Category custom-field **definitions** referenced by the mapping (Phase 72).
   * Used to validate each custom-field column's value through the Phase-70
   * `validateFieldValue` seam and to auto-resolve headers when `mapping` is null.
   * A column targeting a field not in this list collects a row error.
   */
  readonly customFields?: readonly CategoryField[];
}

/**
 * Build a dry-run import plan from a raw CSV string.
 *
 * @param csvText     - The full contents of the uploaded CSV file.
 * @param mapping     - Column index → logical field (from {@link inferColumnMapping}
 *                      or user selection). Omit to auto-infer from the header row.
 * @param existingItems - The current item catalogue used for create-vs-update matching.
 * @param options     - {@link BuildPlanOptions}.
 * @returns A {@link CatalogImportPlan} — never throws; all row errors are collected.
 */
export function buildCatalogImportPlan(
  csvText: string,
  mapping: ColumnMapping | null,
  existingItems: readonly Item[],
  options: BuildPlanOptions = {},
): CatalogImportPlan {
  if (csvText.trim().length === 0) {
    return { create: [], update: [], errors: [] };
  }

  const allRows = parseCsv(csvText).filter((r) => r.some((c) => c.trim().length > 0));
  if (allRows.length === 0) {
    return { create: [], update: [], errors: [] };
  }

  const [headerRow, ...dataRows] = allRows as [string[], ...string[][]];
  return buildImportPlanFromRows(headerRow, dataRows, mapping, existingItems, options);
}

/**
 * The core dry-run plan builder, working from an already-parsed header row and
 * data rows rather than raw CSV text. This is the shared seam that lets multiple
 * front-ends (comma CSV, tab-separated paste, free-form line lists — see
 * `text-import.ts`) reach the same validation + create-vs-update logic without
 * re-implementing it.
 *
 * @param headerRow     - The (already-parsed) header cells; used only to auto-infer
 *                        the mapping when `mapping` is `null`.
 * @param dataRows      - The (already-parsed) data rows, header excluded. Blank rows
 *                        should be filtered out by the caller.
 * @param mapping       - Column index → logical field, or `null` to auto-infer from
 *                        `headerRow` + `options.customFields`.
 * @param existingItems - The current catalogue used for create-vs-update matching.
 * @param options       - {@link BuildPlanOptions}.
 * @returns A {@link CatalogImportPlan} — never throws; all row errors are collected.
 */
export function buildImportPlanFromRows(
  headerRow: readonly string[],
  dataRows: readonly (readonly string[])[],
  mapping: ColumnMapping | null,
  existingItems: readonly Item[],
  options: BuildPlanOptions = {},
): CatalogImportPlan {
  const creates: CatalogCreate[] = [];
  const updates: CatalogUpdate[] = [];
  const errors: CatalogError[] = [];

  const customFields = options.customFields ?? [];
  const resolvedMapping = mapping ?? inferColumnMapping(headerRow, customFields);
  const matchKey = options.matchKey ?? 'name';

  // Field-definition lookup for validating each custom-field column's value.
  const defById = new Map(customFields.map((d) => [d.id, d]));

  // Build fast lookup maps from existing items.
  const byName = new Map<string, Item>();
  const byMpn = new Map<string, Item>();
  for (const item of existingItems) {
    byName.set(item.name, item);
    if (item.mpn) byMpn.set(item.mpn, item);
  }

  // Track keys already seen in THIS import to catch intra-CSV duplicates (the second
  // occurrence is an error, not silently dropped, so the user sees the conflict).
  const seenKeys = new Map<string, number>(); // key → first sourceRow that used it

  for (let i = 0; i < dataRows.length; i += 1) {
    const sourceRow = i + 1; // 1-based
    const row = dataRows[i]!;

    const raw = extractRow(row, resolvedMapping);
    const coerced = coerceRow(raw.core);

    // Validate with Zod — collect errors, never throw.
    const result = catalogRowSchema.safeParse(coerced);
    if (!result.success) {
      const message = result.error.issues.map((issue) => issue.message).join('; ');
      errors.push({ sourceRow, message });
      continue;
    }

    const data = result.data;

    // Validate + coerce any custom-field columns through the Phase-70 seam. An
    // unknown field id or an invalid value is COLLECTED as a row error (never
    // thrown); required is enforced by the seam itself. Only the coerced values
    // (incl. nulls that clear a field) reach the plan, applied later through the
    // existing setItemFieldValues path.
    const fieldValues = resolveCustomFieldValues(raw.custom, defById, sourceRow, errors);
    if (fieldValues === null) continue; // a custom-field value was invalid

    // Determine the match-key value for this row.
    const matchValue: string | null | undefined =
      matchKey === 'name'
        ? data.name
        : (data.sku ?? data.mpn ?? null);

    if (!matchValue) {
      // No match-key value: we can only create if a name is present.
      if (!data.name) {
        // A name is required to create; when matching by SKU/MPN, a missing match
        // value also rules out updating an existing item.
        const message =
          matchKey === 'name'
            ? 'Row has no name — cannot import.'
            : 'Row has no name to create an item, and no SKU/MPN to match an existing one — cannot import.';
        errors.push({ sourceRow, message });
        continue;
      }
      // No match key but has a name — treat as create.
      creates.push({ sourceRow, input: toCreateInput(data), ...withFieldValues(fieldValues) });
      continue;
    }

    // Check for intra-CSV duplicates.
    const prior = seenKeys.get(matchValue);
    if (prior !== undefined) {
      errors.push({
        sourceRow,
        message: `Duplicate ${matchKey === 'name' ? 'name' : 'SKU/MPN'} "${matchValue}" — already used in row ${prior}.`,
      });
      continue;
    }
    seenKeys.set(matchValue, sourceRow);

    // Match against existing items.
    const existingItem = matchKey === 'name' ? byName.get(matchValue) : byMpn.get(matchValue);

    if (existingItem) {
      // Matched → update.
      updates.push({
        sourceRow,
        itemId: existingItem.id,
        input: toUpdateInput(data),
        ...withFieldValues(fieldValues),
      });
    } else {
      // No match → create. A name is required for creates.
      if (!data.name) {
        errors.push({ sourceRow, message: 'Name is required when creating a new item.' });
        continue;
      }
      creates.push({ sourceRow, input: toCreateInput(data), ...withFieldValues(fieldValues) });
    }
  }

  return { create: creates, update: updates, errors };
}

// ---------------------------------------------------------------------------
// Apply helper (runs through existing ItemRepository paths)
// ---------------------------------------------------------------------------

/**
 * Minimal interface the apply helper needs from the item repository. Using an
 * interface rather than the concrete class keeps the pure module free of the
 * worker-bound repository import and makes it instantly unit-testable.
 */
export interface CatalogItemRepository {
  create(input: CreateItemInput): Promise<Item>;
  update(id: string, input: UpdateItemInput): Promise<Item>;
}

/**
 * Minimal interface for persisting custom-field values (Phase 72). Backed in
 * production by `CategoryRepository.setItemFieldValues` — the ONLY custom-field
 * write path; the importer never inserts `item_field_values` rows itself. The
 * values supplied are already validated/coerced (Phase-70 seam); `setItemFieldValues`
 * re-validates and enforces that each field belongs to the item's current category.
 */
export interface CatalogCategoryRepository {
  setItemFieldValues(
    itemId: string,
    values: Readonly<Record<string, string | null>>,
  ): Promise<void>;
}

/** Outcome of a single applied row. */
export interface ApplyRowResult {
  readonly sourceRow: number;
  readonly kind: 'created' | 'updated' | 'skipped';
  /** Present when the row was skipped due to an apply-time error. */
  readonly error?: string;
}

/** Aggregated result returned by {@link applyCatalogImportPlan}. */
export interface CatalogApplyResult {
  readonly created: number;
  readonly updated: number;
  readonly skipped: number;
  readonly rows: readonly ApplyRowResult[];
}

/**
 * Apply a dry-run {@link CatalogImportPlan} through the existing
 * `ItemRepository.create` / `ItemRepository.update` public methods.
 *
 * The Hard Stop is already enforced inside `ItemRepository.create` (which calls
 * `this.assertWritable()`), so we never bypass it. When the repository throws
 * `WRITE_SUSPENDED` the row is recorded as skipped rather than crashing the whole
 * import — the caller's mutation hook surfaces the error to the UI.
 *
 * Rows that appear in `plan.errors` are already invalid and are NOT applied; only
 * the valid `create` and `update` entries are processed.
 *
 * Custom-field values (Phase 72) on a `create`/`update` entry are persisted through
 * the supplied `categories.setItemFieldValues` — the existing custom-field write path
 * — immediately after the item is created/updated. A custom-field write that throws
 * (e.g. the field is not on the item's category) is recorded against the row's
 * `error` without rolling back the item itself; the item create/update still counts.
 *
 * @param plan       - The validated dry-run plan from {@link buildCatalogImportPlan}.
 * @param repo       - The item repository (production: `getItemRepository()`).
 * @param categories - Optional custom-field writer (production:
 *                     `getCategoryRepository()`); required only when the plan carries
 *                     `fieldValues`.
 * @returns An aggregated {@link CatalogApplyResult}.
 */
export async function applyCatalogImportPlan(
  plan: CatalogImportPlan,
  repo: CatalogItemRepository,
  categories?: CatalogCategoryRepository,
): Promise<CatalogApplyResult> {
  const rows: ApplyRowResult[] = [];

  for (const entry of plan.create) {
    try {
      const created = await repo.create(entry.input);
      const fieldError = await applyFieldValues(categories, created.id, entry.fieldValues);
      rows.push({ sourceRow: entry.sourceRow, kind: 'created', ...(fieldError ? { error: fieldError } : {}) });
    } catch (err) {
      rows.push({
        sourceRow: entry.sourceRow,
        kind: 'skipped',
        error: err instanceof Error ? err.message : 'Unknown error during create.',
      });
    }
  }

  for (const entry of plan.update) {
    try {
      await repo.update(entry.itemId, entry.input);
      const fieldError = await applyFieldValues(categories, entry.itemId, entry.fieldValues);
      rows.push({ sourceRow: entry.sourceRow, kind: 'updated', ...(fieldError ? { error: fieldError } : {}) });
    } catch (err) {
      rows.push({
        sourceRow: entry.sourceRow,
        kind: 'skipped',
        error: err instanceof Error ? err.message : 'Unknown error during update.',
      });
    }
  }

  const created = rows.filter((r) => r.kind === 'created').length;
  const updated = rows.filter((r) => r.kind === 'updated').length;
  const skipped = rows.filter((r) => r.kind === 'skipped').length;

  return { created, updated, skipped, rows };
}

/**
 * Persist a row's custom-field values through the existing
 * `CategoryRepository.setItemFieldValues` path. Returns an error message (never
 * throws) when the write fails — so the item create/update is not rolled back — or
 * `undefined` on success / when there is nothing to write.
 */
async function applyFieldValues(
  categories: CatalogCategoryRepository | undefined,
  itemId: string,
  fieldValues: CustomFieldValues | undefined,
): Promise<string | undefined> {
  if (!fieldValues || Object.keys(fieldValues).length === 0) return undefined;
  if (!categories) {
    return 'Custom-field values were ignored: no category repository was provided.';
  }
  try {
    await categories.setItemFieldValues(itemId, fieldValues);
    return undefined;
  } catch (err) {
    return err instanceof Error ? err.message : 'Unknown error writing custom fields.';
  }
}
