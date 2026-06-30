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
import { TRACKING_MODES, CONDITIONS, UNASSIGNED_LOCATION_ID } from '@/db/repositories/constants';
import type { CreateItemInput, UpdateItemInput, Item } from '@/db/repositories/types';

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
 * Maps each CSV header (column index → logical field). A `null` entry means the
 * column is unmapped (ignored).
 */
export type ColumnMapping = ReadonlyArray<CatalogField | null>;

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
 * Infer a {@link ColumnMapping} from a CSV header row. Unrecognised columns map to
 * `null`. Each logical field is assigned at most once (first header wins).
 */
export function inferColumnMapping(headers: readonly string[]): ColumnMapping {
  const assigned = new Set<CatalogField>();
  return headers.map((h) => {
    const key = headerKey(h);
    for (const [synonym, field] of HEADER_SYNONYMS) {
      if (synonym === key && !assigned.has(field)) {
        assigned.add(field);
        return field;
      }
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

/**
 * Extract a {@link CatalogRowData} object from one CSV data row using the column
 * mapping. Returns `undefined` fields for unmapped / absent columns so the Zod
 * schema can distinguish "not supplied" from "supplied as empty".
 */
function extractRow(
  row: readonly string[],
  mapping: ColumnMapping,
): Partial<Record<CatalogField, string | null>> {
  const result: Partial<Record<CatalogField, string | null>> = {};
  for (let i = 0; i < mapping.length; i += 1) {
    const field = mapping[i];
    if (field === null || field === undefined) continue;
    if (field in result) continue; // first column for each logical field wins
    result[field] = rawCell(row, i);
  }
  return result;
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

/** A fully-validated row destined for {@link ItemRepository.create}. */
export interface CatalogCreate {
  /** 1-based index of the source CSV data row (not counting the header). */
  readonly sourceRow: number;
  readonly input: CreateItemInput;
}

/** A fully-validated row destined for {@link ItemRepository.update}. */
export interface CatalogUpdate {
  readonly sourceRow: number;
  /** The id of the matched existing item. */
  readonly itemId: string;
  readonly input: UpdateItemInput;
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
  const creates: CatalogCreate[] = [];
  const updates: CatalogUpdate[] = [];
  const errors: CatalogError[] = [];

  if (csvText.trim().length === 0) {
    return { create: creates, update: updates, errors };
  }

  const allRows = parseCsv(csvText).filter((r) => r.some((c) => c.trim().length > 0));
  if (allRows.length === 0) {
    return { create: creates, update: updates, errors };
  }

  const [headerRow, ...dataRows] = allRows as [string[], ...string[][]];

  const resolvedMapping = mapping ?? inferColumnMapping(headerRow);
  const matchKey = options.matchKey ?? 'name';

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
    const coerced = coerceRow(raw);

    // Validate with Zod — collect errors, never throw.
    const result = catalogRowSchema.safeParse(coerced);
    if (!result.success) {
      const message = result.error.issues.map((issue) => issue.message).join('; ');
      errors.push({ sourceRow, message });
      continue;
    }

    const data = result.data;

    // Determine the match-key value for this row.
    const matchValue: string | null | undefined =
      matchKey === 'name'
        ? data.name
        : (data.sku ?? data.mpn ?? null);

    if (!matchValue) {
      // No match-key value: we can only create if a name is present.
      if (!data.name) {
        errors.push({ sourceRow, message: `Row has no name and no ${matchKey === 'name' ? 'name' : 'SKU/MPN'} — cannot import.` });
        continue;
      }
      // No match key but has a name — treat as create.
      creates.push({ sourceRow, input: toCreateInput(data) });
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
      updates.push({ sourceRow, itemId: existingItem.id, input: toUpdateInput(data) });
    } else {
      // No match → create. A name is required for creates.
      if (!data.name) {
        errors.push({ sourceRow, message: 'Name is required when creating a new item.' });
        continue;
      }
      creates.push({ sourceRow, input: toCreateInput(data) });
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
 * @param plan   - The validated dry-run plan from {@link buildCatalogImportPlan}.
 * @param repo   - The item repository (production: `getItemRepository()`).
 * @returns An aggregated {@link CatalogApplyResult}.
 */
export async function applyCatalogImportPlan(
  plan: CatalogImportPlan,
  repo: CatalogItemRepository,
): Promise<CatalogApplyResult> {
  const rows: ApplyRowResult[] = [];

  for (const entry of plan.create) {
    try {
      await repo.create(entry.input);
      rows.push({ sourceRow: entry.sourceRow, kind: 'created' });
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
      rows.push({ sourceRow: entry.sourceRow, kind: 'updated' });
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
