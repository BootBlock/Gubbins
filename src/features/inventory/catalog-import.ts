/**
 * Bulk catalog CSV import (spec §2 "Spreadsheet onboarding", Phase 67).
 *
 * Parses a user-supplied CSV, maps its columns to {@link CreateItemInput} /
 * {@link UpdateItemInput} fields, validates each row with Zod, and returns a
 * **dry-run plan** that the caller can preview before committing. The plan
 * partitions rows into creates (no matching item found), updates (a match found
 * by the chosen key), and errors (invalid rows — never thrown, always collected).
 *
 * The CSV codec is re-used from the shared {@link readDelimited} in `@/features/import/tabular`
 * (same RFC-4180-safe parser, no new dependency), so an unclosed quote is reported here rather
 * than quietly shortening the plan. The apply helper runs the plan
 * through the existing {@link ItemRepository} `create`/`update` public methods —
 * no new SQL, no new columns.
 *
 * Kept free of React and the DOM for instant unit-test execution.
 */
import { z } from 'zod';
import { TEXT_LIMITS, withinTextLimit } from '@/lib/text-limits';
import { parseCsv, readDelimited, UNTERMINATED_QUOTE_NOTE } from '@/features/import/tabular';
import { parseAmountCell, leadingIntegerCount } from '@/features/import/columns';
import { ensureStorageWritable } from '@/features/storage/write-gate';
import { assertPermissions } from '@/features/users/assert-permission';
import { currentAuthority } from '@/features/users/current-authority';
import { fromDateInputValue, toDateInputValue } from '@/lib/date-input';
import { foldName } from '@/lib/name-fold';
import { validateFieldValue } from './custom-fields';
import { TRACKING_MODES, CONDITIONS, UNASSIGNED_LOCATION_ID } from '@/db/repositories/constants';
import type { TrackingMode } from '@/db/repositories/constants';
import type {
  CategoryField,
  CreateItemInput,
  GaugeInput,
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
  | 'notes'
  | 'sku'
  // Identity columns the scanner and the perishables feature key off (issue #141): the retail
  // barcode is the scanner's exact-lookup key and the serial number the maker's per-unit id,
  // so without them a bulk-loaded catalogue has to be hand-annotated before either works.
  | 'barcode'
  | 'serialNumber'
  | 'quantity'
  | 'locationId'
  | 'categoryId'
  | 'trackingMode'
  // Consumable-Gauge configuration (issue #341): required to create a CONSUMABLE_GAUGE row,
  // meaningless on any other tracking mode.
  | 'unitOfMeasure'
  | 'grossCapacity'
  | 'tareWeight'
  | 'currentNetValue'
  | 'costPerUnitOfMeasure'
  | 'mpn'
  | 'manufacturer'
  | 'unitCost'
  | 'weight'
  | 'width'
  | 'height'
  | 'depth'
  | 'batchNumber'
  | 'lotNumber'
  // The expiry instant that makes a batch/lot useful — it drives the perishables feature and
  // the "expiring soon" widget, and was the one part of a lot's identity a file could not carry.
  | 'expiryDate'
  | 'condition'
  | 'reorderPoint'
  | 'reorderQty'
  | 'isUnlimited'
  // Freeform tags. Not a column on the item row but its own M:N join, so it is applied through
  // `TagRepository.setForItem` after the item lands (see {@link CatalogTagRepository}).
  | 'tags';

/** All recognised logical field names (used for UI pickers). */
export const CATALOG_FIELDS: readonly CatalogField[] = [
  'name',
  'description',
  'notes',
  'sku',
  'barcode',
  'serialNumber',
  'quantity',
  'locationId',
  'categoryId',
  'trackingMode',
  'unitOfMeasure',
  'grossCapacity',
  'tareWeight',
  'currentNetValue',
  'costPerUnitOfMeasure',
  'mpn',
  'manufacturer',
  'unitCost',
  'weight',
  'width',
  'height',
  'depth',
  'batchNumber',
  'lotNumber',
  'expiryDate',
  'condition',
  'reorderPoint',
  'reorderQty',
  'isUnlimited',
  'tags',
];

/** Human-readable label for each field (used in the import wizard UI). */
export const CATALOG_FIELD_LABELS: Record<CatalogField, string> = {
  name: 'Name',
  description: 'Description',
  notes: 'Notes',
  sku: 'SKU / MPN',
  barcode: 'Barcode',
  serialNumber: 'Serial number',
  quantity: 'Quantity',
  locationId: 'Location ID',
  categoryId: 'Category ID',
  trackingMode: 'Tracking mode',
  unitOfMeasure: 'Unit of measure',
  grossCapacity: 'Gross capacity',
  tareWeight: 'Tare weight',
  currentNetValue: 'Net remaining',
  costPerUnitOfMeasure: 'Cost per unit of measure',
  mpn: 'Manufacturer part number',
  manufacturer: 'Manufacturer',
  unitCost: 'Unit cost',
  weight: 'Weight (g)',
  width: 'Width (mm)',
  height: 'Height (mm)',
  depth: 'Depth (mm)',
  batchNumber: 'Batch number',
  lotNumber: 'Lot number',
  expiryDate: 'Expiry date',
  condition: 'Condition',
  reorderPoint: 'Reorder point',
  reorderQty: 'Reorder quantity',
  isUnlimited: 'Unlimited supply',
  tags: 'Tags',
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
  // Deliberately just the exact export header: core synonyms shadow custom-field
  // names, and "Note"/"Comments" are likely custom-field names in the wild.
  ['notes', 'notes'],
  ['sku', 'sku'],
  ['mpn', 'sku'],
  ['manufacturerpartnumber', 'sku'],
  ['partnumber', 'sku'],
  // Retail barcode (issue #141). The GTIN family names are product-identifier words with no
  // other meaning in a stock sheet, so — unlike "Weight" — they are safe to accept loosely.
  // Deliberately *not* `code`/`ref`, which mean anything at all.
  ['barcode', 'barcode'],
  ['gtin', 'barcode'],
  ['ean', 'barcode'],
  ['upc', 'barcode'],
  // Intrinsic serial number (issue #141). `serialno` is included because that is what a great
  // many asset exports call the column; the item's SERIALISED clone index is never a CSV column,
  // so there is nothing for it to collide with. A bare `serial` is deliberately left out — it is
  // exactly the kind of short word a category custom field is called, and a core synonym shadows
  // a same-named custom field.
  ['serialnumber', 'serialNumber'],
  ['serialno', 'serialNumber'],
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
  // Consumable-Gauge configuration (issue #341): the exact export headers and UI labels only,
  // for the same reason `weight` is exact. These columns are meaningful *only* on a gauge row,
  // so a loose synonym would auto-map an unrelated column ("UOM" in an ERP dump, "Capacity" for
  // a battery or a drive) and cost a row its import — as well as shadowing a same-named custom
  // field. A file that spells them differently is mapped by hand in the import wizard.
  ['unitofmeasure', 'unitOfMeasure'],
  ['grosscapacity', 'grossCapacity'],
  ['tareweight', 'tareWeight'],
  ['currentnetvalue', 'currentNetValue'],
  ['netremaining', 'currentNetValue'],
  ['costperunitofmeasure', 'costPerUnitOfMeasure'],
  ['costperunit', 'costPerUnitOfMeasure'],
  ['manufacturer', 'manufacturer'],
  ['mfr', 'manufacturer'],
  ['unitcost', 'unitCost'],
  ['cost', 'unitCost'],
  ['price', 'unitCost'],
  // Just the exact export header (grams). A looser synonym would shadow a custom "Weight" field.
  ['weight', 'weight'],
  // The exact export headers (millimetres). Kept exact so a custom dimension field isn't shadowed.
  ['width', 'width'],
  ['height', 'height'],
  ['depth', 'depth'],
  ['batchnumber', 'batchNumber'],
  ['batch', 'batchNumber'],
  ['lotnumber', 'lotNumber'],
  ['lot', 'lotNumber'],
  // Perishable expiry (issue #141). Every one of these words means a date a thing stops being
  // good, in a grocery export as much as in a calibration schedule, so they map unambiguously.
  ['expirydate', 'expiryDate'],
  ['expiry', 'expiryDate'],
  ['expires', 'expiryDate'],
  ['expiresat', 'expiryDate'],
  ['expiration', 'expiryDate'],
  ['expirationdate', 'expiryDate'],
  ['bestbefore', 'expiryDate'],
  ['bestbeforedate', 'expiryDate'],
  ['useby', 'expiryDate'],
  ['usebydate', 'expiryDate'],
  // Freeform tags (issue #141). Just the two exact forms: "Labels"/"Categories" are far more
  // likely to be somebody's custom field than a tag list.
  ['tags', 'tags'],
  ['tag', 'tags'],
  ['condition', 'condition'],
  ['reorderpoint', 'reorderPoint'],
  ['reorderqty', 'reorderQty'],
  ['reorderquantity', 'reorderQty'],
  ['isunlimited', 'isUnlimited'],
  ['unlimited', 'isUnlimited'],
];

/**
 * The gauge-configuration fields (issue #341). They are only meaningful on a Consumable-Gauge
 * row and ignored on every other, so — unlike every other core field — a category custom field
 * of the same name wins the header in {@link inferColumnMapping}: shadowing "Unit of measure"
 * would silently discard that column's value on a catalogue of ordinary items.
 */
const GAUGE_FIELDS: ReadonlySet<CatalogField> = new Set<CatalogField>([
  'unitOfMeasure',
  'grossCapacity',
  'tareWeight',
  'currentNetValue',
  'costPerUnitOfMeasure',
]);

/**
 * Infer a {@link ColumnMapping} from a CSV header row. Core catalog synonyms win
 * first; a header that matches no core synonym is then matched against the supplied
 * category **custom-field** definitions by normalised name (or exact field id), so a
 * column like `Resistance` targets that category field (Phase 72). Unrecognised
 * columns map to `null`. Each core field and each custom field is assigned at most
 * once (first header wins). The one exception to "core wins" is a {@link GAUGE_FIELDS}
 * column, which yields to a same-named custom field.
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
    // The custom field this header would target, resolved up-front so a gauge column can yield
    // to it. Matched on the normalised header key or the raw (un-normalised) header, the latter
    // so a UUID field id used as a header resolves even though normalisation would strip its
    // hyphens.
    const fieldId = fieldByKey.get(key) ?? fieldByKey.get(h.trim());
    const customFieldFree = fieldId !== undefined && !assignedFieldIds.has(fieldId);
    for (const [synonym, field] of HEADER_SYNONYMS) {
      if (synonym !== key || assigned.has(field)) continue;
      // A gauge column defers to a custom field of the same name (see GAUGE_FIELDS).
      if (GAUGE_FIELDS.has(field) && customFieldFree) break;
      assigned.add(field);
      return field;
    }
    // No core match (or a gauge column that yielded) — target the custom field.
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
  name: z
    .string()
    .trim()
    .min(1, 'Name is required.')
    .refine(withinTextLimit(TEXT_LIMITS.line), 'That entry is too long.')
    .optional(),
  description: z
    .string()
    .trim()
    .refine(withinTextLimit(TEXT_LIMITS.note), 'That entry is too long.')
    .optional()
    .nullable(),
  notes: z
    .string()
    .trim()
    .refine(withinTextLimit(TEXT_LIMITS.note), 'That entry is too long.')
    .optional()
    .nullable(),
  sku: z
    .string()
    .trim()
    .refine(withinTextLimit(TEXT_LIMITS.line), 'That entry is too long.')
    .optional()
    .nullable(),
  barcode: z
    .string()
    .trim()
    .refine(withinTextLimit(TEXT_LIMITS.line), 'That entry is too long.')
    .optional()
    .nullable(),
  serialNumber: z
    .string()
    .trim()
    .refine(withinTextLimit(TEXT_LIMITS.line), 'That entry is too long.')
    .optional()
    .nullable(),
  quantity: z
    .number()
    .int('Quantity must be a whole number.')
    .min(0, 'Quantity cannot be negative.')
    .optional(),
  locationId: z.string().trim().optional(),
  categoryId: z.string().trim().optional().nullable(),
  trackingMode: trackingModeSchema,
  // Consumable-Gauge configuration (issue #341). Optional here because a row of any other
  // tracking mode carries none of it; the per-mode rules (a gauge row needs a unit and a
  // capacity above zero; a non-gauge row must carry neither) are enforced in the plan builder,
  // where the row's resolved tracking mode is known.
  unitOfMeasure: z
    .string()
    .trim()
    .refine(withinTextLimit(TEXT_LIMITS.line), 'That entry is too long.')
    .optional()
    .nullable(),
  grossCapacity: z.number().min(0, 'Gross capacity cannot be negative.').optional().nullable(),
  tareWeight: z.number().min(0, 'Tare weight cannot be negative.').optional().nullable(),
  currentNetValue: z.number().min(0, 'Net remaining cannot be negative.').optional().nullable(),
  costPerUnitOfMeasure: z
    .number()
    .min(0, 'Cost per unit of measure cannot be negative.')
    .optional()
    .nullable(),
  mpn: z
    .string()
    .trim()
    .refine(withinTextLimit(TEXT_LIMITS.line), 'That entry is too long.')
    .optional()
    .nullable(),
  manufacturer: z
    .string()
    .trim()
    .refine(withinTextLimit(TEXT_LIMITS.line), 'That entry is too long.')
    .optional()
    .nullable(),
  unitCost: z.number().min(0, 'Unit cost cannot be negative.').optional().nullable(),
  // Intrinsic weight in canonical grams (issue #25).
  weight: z.number().min(0, 'Weight cannot be negative.').optional().nullable(),
  // Intrinsic bounding-box dimensions in canonical millimetres (issue #30).
  width: z.number().min(0, 'Width cannot be negative.').optional().nullable(),
  height: z.number().min(0, 'Height cannot be negative.').optional().nullable(),
  depth: z.number().min(0, 'Depth cannot be negative.').optional().nullable(),
  batchNumber: z
    .string()
    .trim()
    .refine(withinTextLimit(TEXT_LIMITS.line), 'That entry is too long.')
    .optional()
    .nullable(),
  lotNumber: z
    .string()
    .trim()
    .refine(withinTextLimit(TEXT_LIMITS.line), 'That entry is too long.')
    .optional()
    .nullable(),
  // Already parsed from a `YYYY-MM-DD` cell to a midnight-UTC instant by {@link coerceRow};
  // an unreadable cell never reaches here (it is reported as an unreadable-cell row error).
  expiryDate: z.number().int().optional().nullable(),
  condition: conditionSchema,
  reorderPoint: z
    .number()
    .int('Reorder point must be a whole number.')
    .min(0, 'Reorder point cannot be negative.')
    .optional()
    .nullable(),
  reorderQty: z
    .number()
    .int('Reorder quantity must be a whole number.')
    .min(0, 'Reorder quantity cannot be negative.')
    .optional()
    .nullable(),
  // "Unlimited supply" modifier (Phase 82); DISCRETE-only (enforced in the plan builder).
  isUnlimited: z.boolean().optional(),
  // The row's whole tag set, already split from a comma-separated cell (issue #141). Absent =
  // the file maps no tag column, so an existing item keeps whatever tags it has; an empty array
  // = a mapped-but-blank cell, which replaces the set with nothing (the same "blank clears it"
  // rule every other free-text column follows).
  tags: z.array(z.string().refine(withinTextLimit(TEXT_LIMITS.line), 'That entry is too long.')).optional(),
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

/**
 * Parse one measured/monetary cell, by the same rule every other importer uses (issue #340).
 *
 * The whole cell must be a number, so a partially-numeric value (`12kg`, `~12`, `n/a`) is
 * rejected rather than truncated to its leading digits the way `parseInt` would (issue #339).
 * Beyond that the policy is {@link parseAmountCell}'s: grouped thousands read at full value
 * (`1,500` → 1500, `1 500` → 1500), a currency marker on a price column is stripped rather
 * than dropping a whole row over a decoration, and a comma decimal reads as a decimal
 * (`1,50` → 1.5) so a eurozone supplier's CSV imports its prices here exactly as it does
 * through the BOM and purchase-list importers.
 *
 * A lone separator is the one genuinely ambiguous case — `1,500` is 1500 in the UK and 1.5
 * in Germany. It is settled by the shared heuristic (a three-digit group is grouping, any
 * other tail is a fraction) rather than reported, so a single file cannot import differently
 * depending on which importer reads it. That consistency is the point of issue #340.
 *
 * A whole-count cell (a quantity, a reorder point) reads more loosely — see
 * {@link parseNumericCountCell}; a leading unit suffix such as `3 pcs` is tolerated there but
 * not here, since `1.5 kg` must report rather than drop its fraction.
 *
 * Returns the number, or `null` when the cell is present but unreadable — the caller
 * turns that into a row error, so the import never quietly invents a value.
 *
 * @internal Exported for unit tests only.
 */
export function parseNumericCell(text: string): number | null {
  return parseAmountCell(text);
}

/**
 * Parse one whole-count cell — a quantity, reorder point or reorder quantity — tolerating a
 * trailing unit suffix the way the BOM and purchase-list importers do (issue #391).
 *
 * It reads everything {@link parseNumericCell} reads, and when that fails, falls back to the
 * shared {@link leadingIntegerCount} rule so a hand-written `3 pcs` or `10 units` keeps its
 * leading integer instead of being reported unreadable — the same suffixed cell now imports
 * as three whether the BOM importer or the catalogue importer opens the file. Tolerating the
 * suffix only on the integer count fields, never on amounts, is deliberate: a leading-integer
 * fallback on `1.5 kg` would silently drop the fraction (issue #339 keeps amounts strict).
 *
 * It does **not** round — a fractional value such as `1.5` is passed through so the schema's
 * whole-number rule reports it, rather than the parser quietly altering the count the user
 * wrote. The BOM and purchase-list importers reach the same outcome by a different route:
 * {@link readCountCell} reports a fractional quantity as an unusable cell (issue #350), so no
 * importer rounds a count behind the user's back.
 *
 * @internal Exported for unit tests only.
 */
export function parseNumericCountCell(text: string): number | null {
  return parseNumericCell(text) ?? leadingIntegerCount(text);
}

/**
 * Parse an expiry-date cell into the midnight-UTC instant the item row stores (issue #141).
 *
 * Deliberately strict: the cell must be a bare ISO calendar day, `YYYY-MM-DD` — the exact form
 * the catalogue export writes and the app-wide `<input type="date">` convention
 * ({@link fromDateInputValue}) reads. Everything else is *reported*, never guessed, because the
 * common spreadsheet alternatives cannot be guessed safely: `07/08/2026` is August in Britain and
 * July in America, and picking one silently mis-dates a perishable by a month. That is the same
 * rule the repository applies to the other date fields, which reject anything that is not a bare
 * `YYYY-MM-DD` rather than inherit a timezone shift (issue #327).
 *
 * A day that does not exist (`2026-02-31`) is rejected too: `Date.parse` quietly rolls it forward
 * into March, so the parse is verified by re-serialising and comparing.
 *
 * Returns the instant, or `null` when the cell is present but unreadable — the caller turns that
 * into a row error, so an import never invents an expiry date.
 *
 * @internal Exported for unit tests only.
 */
export function parseExpiryCell(text: string): number | null {
  const trimmed = text.trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return null;
  const ms = fromDateInputValue(trimmed);
  // `Date.parse` rolls an out-of-range day forward, so only a value that reads back as the very
  // day it was written is a real calendar date.
  if (ms === null || toDateInputValue(ms) !== trimmed) return null;
  return ms;
}

/**
 * Split a tags cell into individual tag names (issue #141).
 *
 * Comma is the separator because it is the one the tag editor itself reserves — typing or pasting
 * `fragile,heavy` there commits two tags — so a tag name can never contain one, and the CSV codec
 * quotes the cell for us. Blanks are dropped; ordering and casing are left to
 * `TagRepository.setForItem`, which reuses an existing tag case-insensitively.
 *
 * @internal Exported for unit tests only.
 */
export function parseTagsCell(text: string): string[] {
  return text
    .split(',')
    .map((name) => name.trim())
    .filter((name) => name.length > 0);
}

/**
 * Parse a boolean cell: `true`/`1`/`yes`/`y` (case-insensitive) → `true`,
 * `false`/`0`/`no`/`n` → `false`, an absent cell → `undefined` (leave unchanged). An
 * unrecognised non-empty value also returns `undefined` (treated as "not supplied").
 */
function parseOptionalBool(text: string | null): boolean | undefined {
  if (text === null) return undefined;
  const key = text.trim().toLowerCase();
  if (['true', '1', 'yes', 'y'].includes(key)) return true;
  if (['false', '0', 'no', 'n'].includes(key)) return false;
  return undefined;
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

/** The catalog fields whose cells hold a number (the only ones {@link coerceRow} parses). */
type NumericCatalogField = Extract<
  CatalogField,
  | 'quantity'
  | 'unitCost'
  | 'weight'
  | 'width'
  | 'height'
  | 'depth'
  | 'reorderPoint'
  | 'reorderQty'
  | 'grossCapacity'
  | 'tareWeight'
  | 'currentNetValue'
  | 'costPerUnitOfMeasure'
>;

/**
 * The numeric fields that are whole counts rather than measured/monetary amounts. These read
 * by the looser {@link parseNumericCountCell} rule so a unit-suffixed quantity (`3 pcs`) keeps
 * its leading integer, matching the BOM and purchase-list importers (issue #391). Every other
 * numeric field stays on the strict {@link parseNumericCell} amount rule.
 */
const COUNT_CATALOG_FIELDS = new Set<NumericCatalogField>(['quantity', 'reorderPoint', 'reorderQty']);

/** The outcome of coercing one raw row: the typed data plus any unreadable cells. */
interface CoercedRow {
  readonly data: CatalogRowData;
  /**
   * One message per numeric cell that was present but could not be read as a number.
   * Non-empty means the row must be rejected: an unreadable cell is indistinguishable
   * from an absent one once it reaches the schema, and "absent" silently falls back to
   * the field's default (issue #339).
   */
  readonly unreadable: readonly string[];
}

/**
 * Coerce a raw string-map into a typed {@link CatalogRowData} for Zod parsing.
 * Numeric fields are converted from strings here so Zod receives the right types —
 * including non-integer values such as `1.5`, which are passed through as-is so the
 * schema's whole-number rule reports them rather than the parser silently truncating.
 *
 * The gauge cells are read only on a row whose *resolved* tracking mode is Consumable-Gauge
 * (issue #341); every other row ignores them, and reporting a value the row discards anyway
 * would cost it its import — a shipping sheet's "Tare weight: 12 kg" is not this importer's
 * business unless the row is a gauge.
 */
function coerceRow(raw: Partial<Record<CatalogField, string | null>>): CoercedRow {
  const unreadable: string[] = [];
  const isGauge = raw.trackingMode === 'CONSUMABLE_GAUGE';

  /**
   * Read one numeric cell. An absent cell yields `undefined` ("not supplied"); an
   * unreadable one also yields `undefined` but records a message, so the caller
   * rejects the row instead of importing the field's default value.
   */
  const num = (field: NumericCatalogField): number | undefined => {
    const text = raw[field] ?? null;
    if (text === null) return undefined;
    const value = COUNT_CATALOG_FIELDS.has(field) ? parseNumericCountCell(text) : parseNumericCell(text);
    if (value === null) {
      unreadable.push(`${CATALOG_FIELD_LABELS[field]}: "${text}" is not a number.`);
      return undefined;
    }
    return value;
  };

  /** Read one gauge cell — only on a gauge row (an ignored cell is never reported). */
  const gaugeNum = (field: NumericCatalogField): number | undefined => (isGauge ? num(field) : undefined);

  /**
   * Read the expiry cell (issue #141). Like every other non-text field, an absent or blank cell
   * is "not supplied" and leaves an existing value alone; a cell that is present but is not a
   * `YYYY-MM-DD` day is recorded so the caller rejects the row rather than importing no expiry
   * date at all.
   */
  const expiry = (): number | undefined => {
    const text = raw.expiryDate ?? null;
    if (text === null) return undefined;
    const value = parseExpiryCell(text);
    if (value === null) {
      unreadable.push(`${CATALOG_FIELD_LABELS.expiryDate}: "${text}" is not a date — use YYYY-MM-DD.`);
      return undefined;
    }
    return value;
  };

  return {
    unreadable,
    data: {
      name: raw.name ?? undefined,
      description: raw.description,
      notes: raw.notes,
      // 'sku' in the column map resolves to the `mpn` field on the item — the SKU
      // concept maps directly to the manufacturer part number.
      sku: raw.sku,
      barcode: raw.barcode,
      serialNumber: raw.serialNumber,
      quantity: num('quantity'),
      locationId: raw.locationId ?? undefined,
      categoryId: raw.categoryId,
      trackingMode: (raw.trackingMode ?? undefined) as CatalogRowData['trackingMode'],
      unitOfMeasure: isGauge ? raw.unitOfMeasure : undefined,
      grossCapacity: gaugeNum('grossCapacity'),
      tareWeight: gaugeNum('tareWeight'),
      currentNetValue: gaugeNum('currentNetValue'),
      costPerUnitOfMeasure: gaugeNum('costPerUnitOfMeasure'),
      mpn: raw.mpn,
      manufacturer: raw.manufacturer,
      unitCost: num('unitCost'),
      weight: num('weight'),
      width: num('width'),
      height: num('height'),
      depth: num('depth'),
      batchNumber: raw.batchNumber,
      lotNumber: raw.lotNumber,
      expiryDate: expiry(),
      condition: (raw.condition ?? undefined) as CatalogRowData['condition'],
      reorderPoint: num('reorderPoint'),
      reorderQty: num('reorderQty'),
      isUnlimited: parseOptionalBool(raw.isUnlimited ?? null),
      // An unmapped tag column leaves the key absent (tags untouched); a mapped-but-blank cell
      // yields the empty set, which clears them.
      tags: 'tags' in raw ? parseTagsCell(raw.tags ?? '') : undefined,
    },
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
  /**
   * The item's whole tag set, applied through `TagRepository.setForItem` after the item lands
   * (issue #141). Absent when the import maps no tag column; an empty array means the row's tag
   * cell was blank, which clears the set.
   */
  readonly tags?: readonly string[];
}

/**
 * The on-hand quantity change one update row asks for (issue #592).
 *
 * Quantity is deliberately absent from {@link CatalogUpdate.input}: `items.quantity` is derived
 * from the `item_stock` ledger by trigger, so no column write can move it. The figure is carried
 * here instead and applied through `ItemRepository.adjustQuantity`, which moves the ledger and
 * logs the change to the item's history.
 */
export interface CatalogStockChange {
  /** What the matched item held when the plan was built — what the preview compares against. */
  readonly before: number;
  /** The absolute on-hand quantity the file states. */
  readonly counted: number;
  /**
   * The item's home placement at plan time — the one `adjustQuantity` absorbs the change at.
   * Carried so the apply step can tell whether a *decrease* fits there before writing anything;
   * a whole-item figure says nothing about which drawer the missing units left.
   */
  readonly atLocationId: string;
}

/** A fully-validated row destined for {@link ItemRepository.update}. */
export interface CatalogUpdate {
  readonly sourceRow: number;
  /** The id of the matched existing item. */
  readonly itemId: string;
  readonly input: UpdateItemInput;
  /** Coerced custom-field values to persist after the item is updated. */
  readonly fieldValues?: CustomFieldValues;
  /** The item's whole tag set — see {@link CatalogCreate.tags}. */
  readonly tags?: readonly string[];
  /**
   * The row's on-hand quantity, when it differs from what the matched item already holds
   * (issue #592). Absent when the row states no quantity or states the one the item is already
   * at — an import that changes nothing must not write a history entry saying it did.
   */
  readonly stock?: CatalogStockChange;
  /**
   * Where the row asks the item to be moved to, when its own location cell resolved to somewhere
   * other than where the item is (issue #592). Applied through `ItemRepository.move`, which
   * consolidates the item's placements at the target — `location_id` is not a field on
   * {@link UpdateItemInput} either.
   *
   * A row that states no location of its own never moves the item, **even when the dialog
   * supplies a batch default location**: that default answers "where do the new items go?", not
   * "gather the whole catalogue here".
   */
  readonly moveToLocationId?: string;
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

/**
 * The Consumable-Gauge sub-object for a create, or `undefined` for any other tracking mode.
 *
 * Only ever called for a row that {@link gaugeCreateError} has already passed, so the unit and
 * capacity are known present and sane — the non-null assertions mirror the `name!` above. The
 * optional halves are spread rather than defaulted so `tareWeight: 0` / a zero net value survive
 * as supplied, and an absent column keeps the repository's own default (tare 0, a full item).
 */
function toGaugeInput(data: CatalogRowData): { gauge: GaugeInput } | undefined {
  if ((data.trackingMode ?? 'DISCRETE') !== 'CONSUMABLE_GAUGE') return undefined;
  return {
    gauge: {
      unitOfMeasure: data.unitOfMeasure!.trim(),
      grossCapacity: data.grossCapacity!,
      ...(data.tareWeight === undefined || data.tareWeight === null ? {} : { tareWeight: data.tareWeight }),
      ...(data.currentNetValue === undefined || data.currentNetValue === null
        ? {}
        : { currentNetValue: data.currentNetValue }),
      // Absent leaves the gauge unpriced, which is its own valid state (issue #683) — so an
      // omitted column must not be defaulted to 0, which would read as "worth nothing".
      ...(data.costPerUnitOfMeasure === undefined || data.costPerUnitOfMeasure === null
        ? {}
        : { costPerUnitOfMeasure: data.costPerUnitOfMeasure }),
    },
  };
}

function toCreateInput(data: CatalogRowData): CreateItemInput {
  const mpn = data.sku ?? data.mpn ?? null;
  return {
    name: data.name!, // guaranteed non-empty by Zod
    description: data.description ?? null,
    notes: data.notes ?? null,
    locationId: data.locationId ?? UNASSIGNED_LOCATION_ID,
    categoryId: data.categoryId ?? null,
    trackingMode: data.trackingMode ?? 'DISCRETE',
    ...toGaugeInput(data),
    quantity: data.quantity ?? 0,
    mpn,
    barcode: data.barcode ?? null,
    serialNumber: data.serialNumber ?? null,
    expiryDate: data.expiryDate ?? null,
    manufacturer: data.manufacturer ?? null,
    unitCost: data.unitCost ?? null,
    weight: data.weight ?? null,
    width: data.width ?? null,
    height: data.height ?? null,
    depth: data.depth ?? null,
    batchNumber: data.batchNumber ?? null,
    lotNumber: data.lotNumber ?? null,
    condition: data.condition ?? null,
    reorderPoint: data.reorderPoint ?? null,
    reorderQty: data.reorderQty ?? null,
    isUnlimited: data.isUnlimited ?? false,
  };
}

/**
 * Mirror the DB CHECK at dry-run time (Phase 82): the unlimited-supply flag is DISCRETE-only.
 * Returns a row-error message when `isUnlimited` is set on a non-DISCRETE row, else `null`.
 */
function unlimitedModeError(data: CatalogRowData, mode: TrackingMode): string | null {
  if (data.isUnlimited === true && mode !== 'DISCRETE') {
    return `Only DISCRETE items can be marked as unlimited supply (this row is ${mode}).`;
  }
  return null;
}

/**
 * Mirror the serialised-quantity invariant at dry-run time (issue #348): a SERIALISED item is
 * one instance record, so its quantity is always 1. A row asking for any other quantity is
 * rejected rather than silently coerced down to 1 — the same treatment as the unlimited-supply
 * invariant above, so the user never loses units to a preview that showed a larger number.
 * Returns a row-error message, or `null` when the row is fine.
 */
function serialisedQuantityError(data: CatalogRowData, mode: TrackingMode): string | null {
  if (mode === 'SERIALISED' && data.quantity !== undefined && data.quantity !== 1) {
    return `A serialised item is a single instance, so its quantity must be 1 (this row has ${data.quantity}). Import one row per unit.`;
  }
  return null;
}

/**
 * Why the matched item's on-hand quantity cannot be changed by an import, or `null` when it can.
 *
 * The quantity lands through `ItemRepository.adjustQuantity`, which reconciles DISCRETE stock
 * only, so this repeats that method's tracking-mode guard at dry-run time — the same treatment
 * the unlimited-supply and serialised-quantity invariants get above. Reported per row rather than
 * applied and lost: the preview shows the figure, so the row must either move the stock or say
 * why it will not (issue #592). Held to `adjustQuantity`'s real behaviour by the drift test in
 * `catalog-import-stock.test.ts`.
 */
function updateQuantityError(existing: Item): string | null {
  switch (existing.trackingMode) {
    case 'DISCRETE':
      return null;
    case 'SERIALISED':
      return `"${existing.name}" is serialised, so it is one instance and its quantity is always 1 — import one row per unit rather than a count.`;
    case 'CONSUMABLE_GAUGE':
      return `"${existing.name}" is a consumable gauge, so its level is measured rather than counted — set it from the item's gauge, not an imported quantity.`;
    case 'UNTRACKED':
      return `"${existing.name}" is untracked, so it has no on-hand count for an import to change — switch it to Bulk first.`;
  }
}

/**
 * Mirror the gauge DB CHECK at dry-run time (issue #341): a `CONSUMABLE_GAUGE` item's unit of
 * measure and gross capacity are mandatory, the capacity must be above zero, and — the one part
 * the CHECK itself misses — the net remaining cannot exceed the capacity, an invariant every
 * other gauge write path holds to via `clampNetValue`.
 *
 * Without this the row looked valid in the preview and only failed at apply time — inside the
 * one atomic bulk create — so a single "Consumable" row in a long spreadsheet cost the whole
 * batch. The check has to live here rather than in the schema because it depends on the row's
 * *resolved* tracking mode, which the batch default can supply.
 *
 * Gauge cells on a row of any *other* tracking mode are ignored rather than reported. Unlike the
 * unlimited-supply flag — a boolean that means exactly one thing — these are ordinary spreadsheet
 * headers ("Unit of measure" is in every ERP export), so erroring would cost whole files their
 * import for a column that was harmlessly ignored before the importer knew the name.
 *
 * Returns a row-error message, or `null` when the row is fine.
 */
function gaugeCreateError(data: CatalogRowData, mode: TrackingMode): string | null {
  if (mode !== 'CONSUMABLE_GAUGE') return null;
  const unit = data.unitOfMeasure?.trim() ?? '';
  const capacity = data.grossCapacity ?? null;
  if (unit.length === 0 || capacity === null || capacity <= 0) {
    return `A Consumable-Gauge item needs a ${CATALOG_FIELD_LABELS.unitOfMeasure.toLowerCase()} and a ${CATALOG_FIELD_LABELS.grossCapacity.toLowerCase()} above zero — add those columns, or import this row as Bulk.`;
  }
  const net = data.currentNetValue ?? null;
  if (net !== null && net > capacity) {
    return `${CATALOG_FIELD_LABELS.currentNetValue} (${net}) cannot be more than the ${CATALOG_FIELD_LABELS.grossCapacity.toLowerCase()} (${capacity}) — a gauge cannot hold more than a full one.`;
  }
  return null;
}

/**
 * Every tracking-mode invariant a *create* row must satisfy, checked against the mode the row
 * will be created with. Returns the first violation's message, or `null` when the row is fine.
 */
function createRowModeError(data: CatalogRowData): string | null {
  const mode = data.trackingMode ?? 'DISCRETE';
  return (
    unlimitedModeError(data, mode) ?? serialisedQuantityError(data, mode) ?? gaugeCreateError(data, mode)
  );
}

function toUpdateInput(data: CatalogRowData): UpdateItemInput {
  const mpn = data.sku ?? data.mpn;
  const result: UpdateItemInput = {};
  if (data.name !== undefined) Object.assign(result, { name: data.name });
  if (data.description !== undefined) Object.assign(result, { description: data.description });
  if (data.notes !== undefined) Object.assign(result, { notes: data.notes });
  if (mpn !== undefined) Object.assign(result, { mpn: mpn ?? null });
  if (data.barcode !== undefined) Object.assign(result, { barcode: data.barcode });
  if (data.serialNumber !== undefined) Object.assign(result, { serialNumber: data.serialNumber });
  if (data.expiryDate !== undefined) Object.assign(result, { expiryDate: data.expiryDate });
  if (data.manufacturer !== undefined) Object.assign(result, { manufacturer: data.manufacturer });
  if (data.unitCost !== undefined) Object.assign(result, { unitCost: data.unitCost ?? null });
  if (data.weight !== undefined) Object.assign(result, { weight: data.weight ?? null });
  if (data.width !== undefined) Object.assign(result, { width: data.width ?? null });
  if (data.height !== undefined) Object.assign(result, { height: data.height ?? null });
  if (data.depth !== undefined) Object.assign(result, { depth: data.depth ?? null });
  if (data.batchNumber !== undefined) Object.assign(result, { batchNumber: data.batchNumber });
  if (data.lotNumber !== undefined) Object.assign(result, { lotNumber: data.lotNumber });
  if (data.condition !== undefined) Object.assign(result, { condition: data.condition ?? null });
  if (data.reorderPoint !== undefined) Object.assign(result, { reorderPoint: data.reorderPoint ?? null });
  if (data.reorderQty !== undefined) Object.assign(result, { reorderQty: data.reorderQty ?? null });
  if (data.categoryId !== undefined) Object.assign(result, { categoryId: data.categoryId ?? null });
  if (data.isUnlimited !== undefined) Object.assign(result, { isUnlimited: data.isUnlimited });
  // Quantity and location are deliberately absent too, and for a harder reason than choice:
  // `items.quantity` is derived from the `item_stock` ledger by trigger, and `location_id` moves
  // only alongside the placements it summarises, so neither is a field on `UpdateItemInput` at
  // all. They ride beside this input on the plan entry instead — see `CatalogUpdate.stock` and
  // `CatalogUpdate.moveToLocationId` (issue #592).
  //
  // The gauge columns are deliberately absent (issue #341): an update never rewrites an item's
  // gauge configuration — that is the gauge editor's job, which re-bases the level rather than
  // overwriting it — so they are read only when *creating*. Reporting them here instead would
  // reject an untouched exported catalogue on the way back in, since a re-parsed cell need not
  // compare equal to the stored value it came from.
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
    // An IMAGE field holds binary cover art, not tabular text — a CSV can only carry a marker
    // (see the export side), never the image itself. Silently skip the column rather than
    // erroring the row, so importing an exported catalogue round-trips cleanly (issue #453).
    if (def.fieldType === 'IMAGE') continue;
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
function withFieldValues(values: Record<string, string | null>): { fieldValues?: CustomFieldValues } {
  return Object.keys(values).length > 0 ? { fieldValues: values } : {};
}

/**
 * Spread helper for the row's tag set, attached only when the import actually maps a tag column
 * (issue #141) — so a plan built from a file with no tags keeps its exact previous shape. An
 * empty array *is* attached: that is a blank cell asking for the tags to be cleared, which is
 * different from not mentioning tags at all.
 */
function withTags(tags: readonly string[] | undefined): { tags?: readonly string[] } {
  return tags === undefined ? {} : { tags };
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
   *
   * A name is compared through `foldName`, so a spreadsheet spelling a name in a different case
   * updates the item that is there rather than creating a second one; a SKU/MPN is compared
   * verbatim (see `matchKeyFold`). Neither key is unique in the schema, so a value held by two
   * items collects a row error naming the candidates instead of updating whichever was read
   * last (issue #593).
   */
  readonly matchKey?: MatchKey;
  /**
   * Category custom-field **definitions** referenced by the mapping (Phase 72).
   * Used to validate each custom-field column's value through the Phase-70
   * `validateFieldValue` seam and to auto-resolve headers when `mapping` is null.
   * A column targeting a field not in this list collects a row error.
   */
  readonly customFields?: readonly CategoryField[];
  /**
   * Known locations, so a `locationId` cell holding a **location name** (typed inline
   * as `loc: Workshop`, or a spreadsheet "Location" column) resolves to its id. A cell
   * that already holds a known id passes through. When omitted, location cells are
   * passed through verbatim (legacy behaviour). A non-empty, unresolvable location
   * collects a row error rather than silently creating the item in the wrong place —
   * as does a name held by more than one location, which the tree is expected to allow
   * (issue #593); the user disambiguates by putting the location's id in the cell.
   */
  readonly locations?: readonly { readonly id: string; readonly name: string }[];
  /**
   * Batch default location id, applied to every row that does not specify its own
   * location. Chosen from the import dialog's "Location" dropdown.
   */
  readonly defaultLocationId?: string;
  /**
   * Batch default tracking mode, applied to every row that does not specify its own
   * tracking. Chosen from the import dialog's "Tracking" dropdown.
   */
  readonly defaultTrackingMode?: TrackingMode;
}

/**
 * Normalise a raw tracking cell into a {@link TrackingMode}, accepting both the enum
 * values (`SERIALISED`) and the British-English UI labels (`Serialised`, `Bulk`,
 * `Consumable`, `Untracked`) case-insensitively, so an inline `track: serialised` or a
 * spreadsheet column reading "Bulk" both resolve. Returns `null` for an unknown value.
 *
 * @internal Exported for unit tests only.
 */
export function normaliseTrackingMode(raw: string): TrackingMode | null {
  const key = raw
    .trim()
    .toLowerCase()
    .replace(/[\s_-]/g, '');
  switch (key) {
    case 'discrete':
    case 'bulk':
      return 'DISCRETE';
    case 'serialised':
    case 'serialized':
    case 'serial':
      return 'SERIALISED';
    case 'consumablegauge':
    case 'consumable':
    case 'gauge':
      return 'CONSUMABLE_GAUGE';
    case 'untracked':
    case 'none':
      return 'UNTRACKED';
    default:
      return null;
  }
}

/**
 * The comparison key for a match value, per match key.
 *
 * A **name** compares through {@link foldName}, the one fold the app uses for every natural key
 * a human types, so `widget a` finds the `Widget A` that is already there and a name typed with
 * a combining accent finds its composed form.
 *
 * A **SKU/MPN** compares trimmed and verbatim, as this importer always has. It is a
 * manufacturer's part number rather than a name a user typed, and `mpn` is deliberately not a
 * folded key: `ItemRepository.findByMatchKey` records the same decision for the same reason
 * (issue #679). Widening it is a separate question from this one, and the answer is not
 * `foldName` — that would put a third rule on a column that already has two.
 */
function matchKeyFold(matchKey: MatchKey, value: string): string {
  return matchKey === 'name' ? foldName(value) : value.trim();
}

/**
 * Group rows by a natural key, keeping **every** row that claims a key rather than the last
 * one to be read (issue #593).
 *
 * Nothing in the schema makes any of the importer's match keys unique — there is no unique
 * index on `items(name)`, on `items(mpn)`, or on `locations(name)`, and a location tree is
 * *expected* to repeat names (a `Shelf 1` in two rooms). A `Map` built by plain assignment
 * therefore answers an ambiguous key with whichever row the read happened to return last,
 * which is a silent wrong answer: the wrong item is updated, or the item lands in the wrong
 * place. Collecting the candidates lets the caller report the ambiguity instead of guessing.
 *
 * `normalise` decides what counts as the same key — {@link matchKeyFold} for a match key,
 * {@link foldName} for a location name. Rows whose selector returns `null` or a blank value
 * (an item with no MPN) are skipped.
 */
function groupByKey<T>(
  rows: readonly T[],
  keyOf: (row: T) => string | null,
  normalise: (raw: string) => string,
): Map<string, T[]> {
  const grouped = new Map<string, T[]>();
  for (const row of rows) {
    const raw = keyOf(row);
    if (raw === null || raw.trim().length === 0) continue;
    const key = normalise(raw);
    const bucket = grouped.get(key);
    if (bucket) bucket.push(row);
    else grouped.set(key, [row]);
  }
  return grouped;
}

/** How a raw location cell resolved against the known locations. */
type LocationResolution =
  | { readonly kind: 'resolved'; readonly id: string }
  | { readonly kind: 'unknown' }
  | { readonly kind: 'ambiguous'; readonly ids: readonly string[] };

/**
 * Resolve a raw location cell (an id or a name) against the known locations. An exact
 * id match wins; otherwise a folded name match. A name held by more than one location
 * resolves to `ambiguous` rather than to one of them, and an unmatched name to `unknown`
 * — the caller turns either into a row error.
 */
function resolveLocationId(
  raw: string,
  byId: ReadonlyMap<string, string>,
  byName: ReadonlyMap<string, readonly string[]>,
): LocationResolution {
  const trimmed = raw.trim();
  if (byId.has(trimmed)) return { kind: 'resolved', id: trimmed };
  const candidates = byName.get(foldName(trimmed));
  if (candidates === undefined || candidates.length === 0) return { kind: 'unknown' };
  if (candidates.length > 1) return { kind: 'ambiguous', ids: candidates };
  return { kind: 'resolved', id: candidates[0]! };
}

/** Cap on how many candidates an ambiguity message spells out before it summarises the rest. */
const MAX_LISTED_CANDIDATES = 3;

/**
 * Render a candidate list for an ambiguity message: up to {@link MAX_LISTED_CANDIDATES}
 * quoted values, then `and N more` so a name shared by fifty rows does not produce a
 * fifty-entry error.
 */
function listCandidates(values: readonly string[]): string {
  const shown = values.slice(0, MAX_LISTED_CANDIDATES).map((v) => `"${v}"`);
  const rest = values.length - shown.length;
  return rest > 0 ? `${shown.join(', ')} and ${rest} more` : shown.join(', ');
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

  // An unclosed quote merges every line after it into one cell, so the rows past that point
  // describe nothing. Reported as a plan error (row 0 — the file, not a row) rather than let
  // through as a shorter catalogue nobody was told about (issue #591).
  const read = readDelimited(csvText, ',');
  if (read.unterminatedQuote) {
    return { create: [], update: [], errors: [{ sourceRow: 0, message: UNTERMINATED_QUOTE_NOTE }] };
  }

  const allRows = read.rows.filter((r) => r.some((c) => c.trim().length > 0));
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

  // Location resolution maps (id → id, lower-cased name → id). Only built when the
  // caller supplies the known locations; otherwise location cells pass through as-is.
  const locations = options.locations ?? [];
  const resolveLocations = locations.length > 0;
  const locationById = new Map(locations.map((l) => [l.id, l.id]));
  const locationIdsByName = new Map(
    [...groupByKey(locations, (l) => l.name, foldName)].map(([key, ls]) => [key, ls.map((l) => l.id)]),
  );

  // Lookup maps from existing items, holding every item that claims a key so an ambiguous one is
  // reported rather than resolved to whichever item was read last (issue #593). Both index through
  // `matchKeyFold`, the same function the row lookup below keys on, so the two cannot drift apart.
  const byName = groupByKey(
    existingItems,
    (item) => item.name,
    (raw) => matchKeyFold('name', raw),
  );
  const byMpn = groupByKey(
    existingItems,
    (item) => item.mpn,
    (raw) => matchKeyFold('sku', raw),
  );

  // Track keys already seen in THIS import to catch intra-CSV duplicates (the second
  // occurrence is an error, not silently dropped, so the user sees the conflict).
  const seenKeys = new Map<string, number>(); // key → first sourceRow that used it

  for (let i = 0; i < dataRows.length; i += 1) {
    const sourceRow = i + 1; // 1-based
    const row = dataRows[i]!;

    const raw = extractRow(row, resolvedMapping);

    // Resolve the tracking mode: a supplied cell is normalised (enum or label);
    // otherwise the batch default (if any) applies. An unknown value is a row error.
    const rawTracking = raw.core.trackingMode ?? null;
    if (rawTracking !== null) {
      const mode = normaliseTrackingMode(rawTracking);
      if (mode === null) {
        errors.push({ sourceRow, message: `Unknown tracking mode "${rawTracking}".` });
        continue;
      }
      raw.core.trackingMode = mode;
    } else if (options.defaultTrackingMode !== undefined) {
      raw.core.trackingMode = options.defaultTrackingMode;
    }

    // Resolve the location: a supplied cell (id or name) is resolved against the known
    // locations; otherwise the batch default (if any) applies. An unresolvable name is
    // a row error so the item is never silently created in the wrong place.
    const rawLocation = raw.core.locationId ?? null;
    // Whether the *row itself* named a location, remembered before the batch default fills the
    // gap. A matched item is moved only when its own cell says so (issue #592) — the default is
    // "where do the new items go?", and letting it move every matched item would relocate a whole
    // catalogue on an import that never mentioned locations.
    const locationStatedByRow = rawLocation !== null;
    if (rawLocation !== null && resolveLocations) {
      const resolved = resolveLocationId(rawLocation, locationById, locationIdsByName);
      if (resolved.kind === 'unknown') {
        errors.push({ sourceRow, message: `Unknown location "${rawLocation}".` });
        continue;
      }
      if (resolved.kind === 'ambiguous') {
        errors.push({
          sourceRow,
          message: `Ambiguous location "${rawLocation}" — ${resolved.ids.length} locations share this name. Use the location's id instead (${listCandidates(resolved.ids)}).`,
        });
        continue;
      }
      raw.core.locationId = resolved.id;
    } else if (rawLocation === null && options.defaultLocationId !== undefined) {
      raw.core.locationId = options.defaultLocationId;
    }

    const { data: coerced, unreadable } = coerceRow(raw.core);

    // A numeric cell that was supplied but can't be read is a row error, not a silent
    // fallback to the field's default (issue #339).
    if (unreadable.length > 0) {
      errors.push({ sourceRow, message: unreadable.join('; ') });
      continue;
    }

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
      matchKey === 'name' ? data.name : (data.sku ?? data.mpn ?? null);

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
      const createError = createRowModeError(data);
      if (createError) {
        errors.push({ sourceRow, message: createError });
        continue;
      }
      creates.push({
        sourceRow,
        input: toCreateInput(data),
        ...withFieldValues(fieldValues),
        ...withTags(data.tags),
      });
      continue;
    }

    // Check for intra-CSV duplicates, on the same key the catalogue lookup below uses — so two
    // name rows differing only in case collide here rather than both claiming one existing item.
    const rowKey = matchKeyFold(matchKey, matchValue);
    const prior = seenKeys.get(rowKey);
    if (prior !== undefined) {
      errors.push({
        sourceRow,
        message: `Duplicate ${matchKey === 'name' ? 'name' : 'SKU/MPN'} "${matchValue}" — already used in row ${prior}.`,
      });
      continue;
    }
    seenKeys.set(rowKey, sourceRow);

    // Match against existing items. A key held by more than one item is an error naming the
    // candidates, not a guess at which one the row meant (issue #593).
    const candidates = (matchKey === 'name' ? byName : byMpn).get(rowKey) ?? [];
    if (candidates.length > 1) {
      errors.push({
        sourceRow,
        message:
          matchKey === 'name'
            ? `Ambiguous name "${matchValue}" — ${candidates.length} existing items share it. Rename them so the name is unique, or match by SKU/MPN instead.`
            : `Ambiguous SKU/MPN "${matchValue}" — shared by ${listCandidates(candidates.map((c) => c.name))}. Give them distinct SKU/MPNs, or match by name instead.`,
      });
      continue;
    }
    const existingItem = candidates[0];

    if (existingItem) {
      // Matched → update. Mirror the DB CHECK against the *existing* item's mode (an update
      // never changes tracking_mode), so unlimited can't be set on a non-DISCRETE item.
      const unlimitedError = unlimitedModeError(data, existingItem.trackingMode);
      if (unlimitedError) {
        errors.push({ sourceRow, message: unlimitedError });
        continue;
      }
      // A stated quantity that already matches the item is not a change — it is what an exported
      // catalogue looks like coming back in — so it plans nothing and is never reported.
      const wantsStock = data.quantity !== undefined && data.quantity !== existingItem.quantity;
      if (wantsStock) {
        const quantityError = updateQuantityError(existingItem);
        if (quantityError) {
          errors.push({ sourceRow, message: quantityError });
          continue;
        }
      }
      // A move needs a location the plan actually *resolved*. With no known locations supplied
      // the cell passes through verbatim (the legacy behaviour documented on
      // {@link BuildPlanOptions.locations}), and handing a raw spreadsheet name to `move` as an
      // id would only trade a dropped cell for a foreign-key error. Every production caller
      // supplies them.
      const wantsMove =
        resolveLocations &&
        locationStatedByRow &&
        data.locationId !== undefined &&
        data.locationId !== existingItem.locationId;
      updates.push({
        sourceRow,
        itemId: existingItem.id,
        input: toUpdateInput(data),
        ...withFieldValues(fieldValues),
        ...withTags(data.tags),
        ...(wantsStock
          ? {
              stock: {
                before: existingItem.quantity,
                counted: data.quantity!,
                atLocationId: existingItem.locationId,
              },
            }
          : {}),
        ...(wantsMove ? { moveToLocationId: data.locationId! } : {}),
      });
    } else {
      // No match → create. A name is required for creates.
      if (!data.name) {
        errors.push({ sourceRow, message: 'Name is required when creating a new item.' });
        continue;
      }
      const createError = createRowModeError(data);
      if (createError) {
        errors.push({ sourceRow, message: createError });
        continue;
      }
      creates.push({
        sourceRow,
        input: toCreateInput(data),
        ...withFieldValues(fieldValues),
        ...withTags(data.tags),
      });
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
  /**
   * Optional bulk-create fast path: create all inputs in one atomic transaction
   * (one commit for the whole batch). When present it is used for the plan's `create`
   * partition, collapsing the per-row commits that make a large import slow. Returns
   * the created items in input order. Absent on lightweight test doubles, which fall
   * back to per-row {@link create}.
   */
  createMany?(inputs: readonly CreateItemInput[]): Promise<Item[]>;
  /**
   * Move an item wholesale to another location, consolidating its placements there (issue #592).
   * Optional so the lightweight test doubles that never map a location column keep compiling; a
   * plan that *does* ask for a move through a repository without it reports the row rather than
   * dropping the move silently — which is the defect this whole seam exists to fix.
   */
  move?(id: string, locationId: string): Promise<Item>;
  /**
   * Move a DISCRETE item's on-hand stock by a signed delta, logging the change (issue #592).
   * Optional on the same terms as {@link move}.
   */
  adjustQuantity?(id: string, delta: number, note?: string): Promise<Item>;
  /**
   * Where an item's stock currently sits, per location (issue #592). Read before a *decrease*, to
   * check the draw fits the placement {@link adjustQuantity} will take it from. Optional on the
   * same terms as {@link move}; without it a decrease is refused rather than risked.
   */
  listStock?(itemId: string): Promise<readonly { readonly locationId: string; readonly quantity: number }[]>;
}

/**
 * Minimal interface for persisting custom-field values (Phase 72). Backed in
 * production by `CategoryRepository.setItemFieldValues` — the ONLY custom-field
 * write path; the importer never inserts `item_field_values` rows itself. The
 * values supplied are already validated/coerced (Phase-70 seam); `setItemFieldValues`
 * re-validates and enforces that each field belongs to the item's current category.
 *
 * Deliberately narrower than the repository method: it takes no `originDeviceId` (W1g), so an
 * imported value is unattributed. A spreadsheet's cells were authored wherever the spreadsheet
 * was, which the importing device has no way to know — and a `FILE` path claimed for this
 * device when it in fact came from another is precisely the false statement W1g removes.
 */
export interface CatalogCategoryRepository {
  setItemFieldValues(itemId: string, values: Readonly<Record<string, string | null>>): Promise<void>;
}

/**
 * Minimal interface for persisting an item's tag set (issue #141). Backed in production by
 * `TagRepository.setForItem` — the same low-friction write the tag editor uses, so an unknown
 * tag name auto-creates its tag and a known one is reused case-insensitively, and the importer
 * never touches the `tags` / `item_tags` rows itself.
 */
export interface CatalogTagRepository {
  setForItem(itemId: string, names: readonly string[]): Promise<void>;
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
 * That per-row guard reads quota telemetry that is only refreshed periodically, though, and an
 * import is exactly the operation that can consume the remaining quota inside one poll window
 * (issue #200). So the import re-measures once up front via {@link ensureStorageWritable}, which
 * throws before any row is attempted if that fresh reading is at the locked tier.
 *
 * Rows that appear in `plan.errors` are already invalid and are NOT applied; only
 * the valid `create` and `update` entries are processed.
 *
 * An `update` entry's on-hand quantity and location are applied through `move` /
 * `adjustQuantity` (issue #592) rather than the item row, because neither is a column the row
 * owns; a failure there is recorded against the row's `error` and still counts as an update,
 * since the item's own fields did land.
 *
 * Custom-field values (Phase 72) on a `create`/`update` entry are persisted through
 * the supplied `categories.setItemFieldValues` — the existing custom-field write path
 * — immediately after the item is created/updated, and a `tags` set through
 * `tags.setForItem` (issue #141) the same way. Neither is a column on the item row, so both
 * are separate writes; one that throws (e.g. the field is not on the item's category) is
 * recorded against the row's `error` without rolling back the item itself, and the item
 * create/update still counts.
 *
 * Gated on `import:run` (issue #429), asserted here — the single point at which a previewed plan
 * stops being a preview and becomes thousands of rows — and **in addition to** the `items:write`
 * every `create`/`update` below still asserts for itself. The two say different things: editing
 * one record and merging a supplier's catalogue into the whole inventory are different acts with
 * different consequences, which is why `import` is a subject of its own rather than an action on
 * `items`. The dry-run plan builder is deliberately left ungated — building a preview writes
 * nothing, and refusing it would leave the user unable to see why the import was refused.
 *
 * @param plan       - The validated dry-run plan from {@link buildCatalogImportPlan}.
 * @param repo       - The item repository (production: `getItemRepository()`).
 * @param categories - Optional custom-field writer (production:
 *                     `getCategoryRepository()`); required only when the plan carries
 *                     `fieldValues`.
 * @param tags       - Optional tag writer (production: `getTagRepository()`); required only
 *                     when the plan carries `tags`.
 * @returns An aggregated {@link CatalogApplyResult}.
 */
export async function applyCatalogImportPlan(
  plan: CatalogImportPlan,
  repo: CatalogItemRepository,
  categories?: CatalogCategoryRepository,
  tags?: CatalogTagRepository,
): Promise<CatalogApplyResult> {
  assertPermissions(currentAuthority(), ['import:run']);
  await ensureStorageWritable();
  const rows: ApplyRowResult[] = [];

  if (repo.createMany && plan.create.length > 0) {
    // Bulk fast path: one transaction for the whole create partition (one commit).
    try {
      const created = await repo.createMany(plan.create.map((entry) => entry.input));
      for (let i = 0; i < plan.create.length; i += 1) {
        const entry = plan.create[i]!;
        const item = created[i];
        if (!item) {
          rows.push({ sourceRow: entry.sourceRow, kind: 'skipped', error: 'Item was not created.' });
          continue;
        }
        const sideError = await applyRowSideEffects(categories, tags, item.id, entry, true);
        rows.push({
          sourceRow: entry.sourceRow,
          kind: 'created',
          ...(sideError ? { error: sideError } : {}),
        });
      }
    } catch (err) {
      // The batch is atomic: if it throws (e.g. the Hard Stop, or a constraint) no item
      // was created, so every create row is recorded as skipped with the same reason.
      const message = err instanceof Error ? err.message : 'Unknown error during create.';
      for (const entry of plan.create) {
        rows.push({ sourceRow: entry.sourceRow, kind: 'skipped', error: message });
      }
    }
  } else {
    for (const entry of plan.create) {
      try {
        const created = await repo.create(entry.input);
        const sideError = await applyRowSideEffects(categories, tags, created.id, entry, true);
        rows.push({
          sourceRow: entry.sourceRow,
          kind: 'created',
          ...(sideError ? { error: sideError } : {}),
        });
      } catch (err) {
        rows.push({
          sourceRow: entry.sourceRow,
          kind: 'skipped',
          error: err instanceof Error ? err.message : 'Unknown error during create.',
        });
      }
    }
  }

  for (const entry of plan.update) {
    try {
      await repo.update(entry.itemId, entry.input);
      // The move runs before the count: a shortfall is drawn out of the item's primary location
      // alone, so an item split across drawers has to be gathered first or the draw asks that
      // one placement for units it does not hold.
      const stockError = await applyStockAndLocation(repo, entry);
      const sideError = await applyRowSideEffects(categories, tags, entry.itemId, entry, false);
      const error = [stockError, sideError].filter((m): m is string => m !== undefined).join(' ');
      rows.push({
        sourceRow: entry.sourceRow,
        kind: 'updated',
        ...(error.length > 0 ? { error } : {}),
      });
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
 * Apply the two parts of an update row that are not columns on the item at all — where it lives
 * and how much of it there is (issue #592).
 *
 * Both go through the repository methods that already own them: `move` consolidates the item's
 * per-location placements at the target, and `adjustQuantity` moves the stock ledger by the
 * variance and logs it to the item's history. Neither can be expressed as an `UpdateItemInput`
 * field — `items.quantity` is trigger-derived from the ledger — which is precisely why the
 * importer used to show both and write neither.
 *
 * The delta is measured from the quantity the plan was built against, so it applies as the
 * relative movement the preview described. Like the whole-item branch of a cycle count, it is
 * **not** captured as an absolute assertion, so the same import run on two devices before they
 * sync applies the correction twice — the hazard `withAssertedCount` describes
 * (`db/repositories/stock-batches.ts`). An assertion is per `stock_batches` row, and a
 * whole-item figure does not name a lot.
 *
 * `ItemRepository.reconcile` states an absolute count and composes its own note from live
 * figures, which would be the better fit but for the note itself: it reads "Cycle count of
 * <location>: …", and a spreadsheet arriving in the importer is not a cycle count of anywhere.
 * Writing that would be a false ledger entry of exactly the kind this issue is about, so the
 * change goes through `adjustQuantity`, whose note the caller supplies.
 *
 * The move is attempted first — see the caller — because `adjustQuantity` draws a shortfall from
 * the item's primary location only. Where there is no move to gather the item, a decrease the
 * home placement cannot cover is refused outright — see {@link drawTooWideToLand}.
 *
 * Like {@link applyRowSideEffects} this never throws: a failure is returned as a message so the
 * item's own update is not rolled back, and both halves are attempted so a row that got the
 * location wrong *and* the count wrong says so once.
 */
/**
 * Why a decrease cannot be applied, or `null` when it can (issue #592).
 *
 * `adjustQuantity` checks the delta against the item's grand total and then draws it from the
 * home placement alone, discarding whatever that placement could not cover. On an item split
 * across drawers a whole-item count would therefore empty the home placement, leave the rest
 * where it was, and still write the full variance to the ledger — a figure the item never
 * reached, recorded as though it had.
 *
 * A row that names a location never gets here: its move gathers every placement at the target
 * first, so the draw always fits. Nor does an *increase*, which lands in one place regardless.
 */
async function drawTooWideToLand(
  repo: CatalogItemRepository,
  entry: CatalogUpdate,
  draw: number,
): Promise<string | null> {
  const stock = entry.stock;
  if (stock === undefined) return null;
  // A gathered item is a single placement by construction — see the caller's ordering.
  if (entry.moveToLocationId !== undefined) return null;
  if (!repo.listStock) {
    return 'The quantity was not changed: this repository cannot check where the stock sits.';
  }
  const placements = await repo.listStock(entry.itemId);
  const atHome = placements.find((p) => p.locationId === stock.atLocationId)?.quantity ?? 0;
  if (atHome >= draw) return null;
  return "The quantity was not changed: this item's stock sits in more than one location, and an imported count says nothing about which one lost units. Count each location with a stock-take, or add a location column to the file.";
}

async function applyStockAndLocation(
  repo: CatalogItemRepository,
  entry: CatalogUpdate,
): Promise<string | undefined> {
  const messages: string[] = [];

  if (entry.moveToLocationId !== undefined) {
    if (!repo.move) {
      messages.push('The location was ignored: this repository cannot move items.');
    } else {
      try {
        await repo.move(entry.itemId, entry.moveToLocationId);
      } catch (err) {
        messages.push(err instanceof Error ? err.message : 'Unknown error moving the item.');
      }
    }
  }

  if (entry.stock !== undefined) {
    const delta = entry.stock.counted - entry.stock.before;
    const unlandable = delta < 0 ? await drawTooWideToLand(repo, entry, -delta) : null;
    if (!repo.adjustQuantity) {
      messages.push('The quantity was ignored: this repository cannot adjust stock.');
    } else if (unlandable !== null) {
      messages.push(unlandable);
    } else {
      try {
        await repo.adjustQuantity(
          entry.itemId,
          delta,
          `Quantity set to ${entry.stock.counted} by an import (was ${entry.stock.before}).`,
        );
      } catch (err) {
        messages.push(err instanceof Error ? err.message : 'Unknown error adjusting the quantity.');
      }
    }
  }

  return messages.length > 0 ? messages.join(' ') : undefined;
}

/**
 * Persist the parts of a row that are not columns on the item itself — its custom-field values
 * and its tag set — through the existing `CategoryRepository.setItemFieldValues` /
 * `TagRepository.setForItem` write paths.
 *
 * Both are attempted even if the first fails, and their messages are joined: an import that got
 * the fields wrong *and* the tags wrong should say so once rather than hide half of it behind the
 * other. Returns the message(s) (never throws) so the item create/update is not rolled back, or
 * `undefined` when everything wrote / there was nothing to write.
 */
async function applyRowSideEffects(
  categories: CatalogCategoryRepository | undefined,
  tags: CatalogTagRepository | undefined,
  itemId: string,
  entry: { readonly fieldValues?: CustomFieldValues; readonly tags?: readonly string[] },
  isNew: boolean,
): Promise<string | undefined> {
  const messages = [
    await applyFieldValues(categories, itemId, entry.fieldValues),
    await applyTagNames(tags, itemId, entry.tags, isNew),
  ].filter((m): m is string => m !== undefined);
  return messages.length > 0 ? messages.join(' ') : undefined;
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

/**
 * Persist a row's tag set through the existing `TagRepository.setForItem` path (issue #141),
 * which auto-creates unknown tags and reuses known ones case-insensitively. On an **update** an
 * empty set is still written — that is a blank tag cell asking for the item's tags to be cleared,
 * which `setForItem` does by diffing. On a **create** it is skipped: a just-created item has no
 * tags to clear, and a whole-file blank tag column would otherwise cost one read per row.
 * Returns an error message (never throws) or `undefined`.
 */
async function applyTagNames(
  tags: CatalogTagRepository | undefined,
  itemId: string,
  names: readonly string[] | undefined,
  isNew: boolean,
): Promise<string | undefined> {
  if (names === undefined) return undefined;
  if (isNew && names.length === 0) return undefined;
  if (!tags) {
    return 'Tags were ignored: no tag repository was provided.';
  }
  try {
    await tags.setForItem(itemId, names);
    return undefined;
  } catch (err) {
    return err instanceof Error ? err.message : 'Unknown error writing tags.';
  }
}
