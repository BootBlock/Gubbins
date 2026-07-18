/**
 * Migration mappers (Phase EI-3) — bring an existing inventory *in* from another
 * tool.
 *
 * Each supported source (Homebox, Grocy, Sortly, Snipe-IT, InvenTree) exports its
 * catalogue with its *own* column names, as does a distributor order export (LCSC) —
 * the same reshaping problem, so it rides the same seam. A migration mapper is a pure
 * **field-mapping** that sits in *front* of the existing generalised-import pipeline:
 * given the already parsed header + data-row matrix (from {@link extractImport} in
 * `text-import.ts`), it rewrites the columns into the canonical Gubbins fields the shared
 * {@link buildImportPlanFromRows} already understands, and folds every column it does
 * *not* recognise into a single `notes` column with a clear provenance line — so nothing
 * is silently mis-mapped and no source data is lost.
 *
 * This module deliberately owns **no** validation, create-vs-update, or write logic: it
 * only reshapes rows. The reshaped matrix flows through the *unchanged*
 * `buildImportPlanFromRows` → `applyCatalogImportPlan` pipeline, so there is no second
 * import path, no new SQL, and every existing guard still applies.
 *
 * Category assignment is intentionally *not* mapped: Gubbins categories are referenced by
 * id (with per-category custom fields), and the source tools export a category *name*
 * with no stable id. Rather than fabricate a dangling category reference, a source's
 * category/group column is folded into the provenance notes so the information survives
 * and the user can assign a real category afterwards.
 *
 * Kept free of React and the DOM for instant unit-test execution.
 */
import { CATALOG_FIELD_LABELS, type CatalogField, type ColumnMapping } from '../catalog-import';

// ---------------------------------------------------------------------------
// Source model
// ---------------------------------------------------------------------------

/** The migration sources understood by the importer. */
export type MigrationSourceId = 'homebox' | 'grocy' | 'sortly' | 'snipeit' | 'inventree' | 'lcsc';

/** One field-mapping rule: any of `keys` (normalised) maps to the Gubbins `target`. */
interface FieldRule {
  readonly keys: readonly string[];
  readonly target: CatalogField;
}

/** A named source format and how to recognise + reshape its export. */
interface MigrationSpec {
  readonly id: MigrationSourceId;
  /** Human label, used in the picker and in the provenance notes line. */
  readonly label: string;
  /** One-line "how to export from this tool" hint (surfaced in the docs / UI). */
  readonly exportHint: string;
  /** Column → field rules; the first rule matching a column wins. */
  readonly rules: readonly FieldRule[];
  /**
   * Normalised column keys that, when *all* present, positively identify this source
   * for auto-detection. Chosen to be unique to the tool so detection is unambiguous.
   */
  readonly signature: readonly string[];
  /**
   * Asset-oriented sources (one row = one physical asset) that carry no quantity
   * column: a synthetic `quantity` of 1 is added so each asset lands as a single item
   * rather than defaulting to zero stock.
   */
  readonly assetLike?: boolean;
}

/** Normalise a header cell to a comparison key (lowercase, alphanumerics only). */
function normaliseKey(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, '');
}

// ---------------------------------------------------------------------------
// The source specifications
// ---------------------------------------------------------------------------
//
// Each rule's `keys` are already normalised (lowercase, no punctuation), and cover both
// a tool's current export headers and common legacy variants. Identifier columns
// (model / part / barcode numbers) target `mpn` — the item's manufacturer-part-number
// slot, which the pipeline also treats as the SKU. Everything not listed here is folded
// into the provenance notes, never guessed at.

const MIGRATION_SPECS: readonly MigrationSpec[] = [
  {
    id: 'homebox',
    label: 'Homebox',
    exportHint: 'Homebox → Tools → Export, which produces an "HB."-prefixed CSV.',
    // The `HB.import_ref` column is unique to a Homebox export.
    signature: ['hbimportref'],
    rules: [
      { keys: ['hbname', 'name'], target: 'name' },
      { keys: ['hbdescription', 'description'], target: 'description' },
      { keys: ['hbquantity', 'quantity'], target: 'quantity' },
      { keys: ['hblocation', 'location'], target: 'locationId' },
      { keys: ['hbmanufacturer', 'manufacturer'], target: 'manufacturer' },
      { keys: ['hbmodelnumber', 'modelnumber'], target: 'mpn' },
      { keys: ['hbnotes', 'notes'], target: 'notes' },
      { keys: ['hbpurchaseprice', 'purchaseprice', 'purchasedprice'], target: 'unitCost' },
    ],
  },
  {
    id: 'grocy',
    label: 'Grocy',
    exportHint: 'Grocy → Stock overview / Products → export the product list as CSV.',
    signature: ['minstockamount', 'quantityunit'],
    rules: [
      { keys: ['product', 'name'], target: 'name' },
      { keys: ['description'], target: 'description' },
      { keys: ['amount', 'stockamount', 'quantity'], target: 'quantity' },
      { keys: ['location'], target: 'locationId' },
      { keys: ['barcode', 'gtin', 'barcodes'], target: 'mpn' },
      { keys: ['minstockamount'], target: 'reorderPoint' },
      { keys: ['lastprice', 'price'], target: 'unitCost' },
    ],
  },
  {
    id: 'sortly',
    label: 'Sortly',
    exportHint: 'Sortly → Export → CSV (all items).',
    signature: ['itemtype', 'minlevel'],
    rules: [
      { keys: ['name', 'entryname'], target: 'name' },
      { keys: ['notes'], target: 'notes' },
      { keys: ['quantity'], target: 'quantity' },
      { keys: ['price'], target: 'unitCost' },
      { keys: ['barcode', 'qrcode'], target: 'mpn' },
      { keys: ['minlevel'], target: 'reorderPoint' },
      { keys: ['folder', 'folderlocation', 'location'], target: 'locationId' },
    ],
  },
  {
    id: 'snipeit',
    label: 'Snipe-IT',
    exportHint: 'Snipe-IT → Assets → Export → CSV.',
    signature: ['assettag'],
    assetLike: true,
    rules: [
      { keys: ['name', 'assetname'], target: 'name' },
      { keys: ['modelnumber'], target: 'mpn' },
      { keys: ['manufacturer'], target: 'manufacturer' },
      { keys: ['location', 'locationname'], target: 'locationId' },
      { keys: ['purchasecost', 'cost'], target: 'unitCost' },
      { keys: ['notes'], target: 'notes' },
    ],
  },
  {
    id: 'inventree',
    label: 'InvenTree',
    exportHint: 'InvenTree → Part list → Download / Export → CSV.',
    signature: ['ipn'],
    rules: [
      { keys: ['name'], target: 'name' },
      { keys: ['description'], target: 'description' },
      { keys: ['ipn'], target: 'mpn' },
      { keys: ['instock', 'totalstock', 'stock'], target: 'quantity' },
      { keys: ['minimumstock', 'minstock'], target: 'reorderPoint' },
      { keys: ['defaultlocation', 'location'], target: 'locationId' },
      { keys: ['notes'], target: 'notes' },
    ],
  },
  {
    id: 'lcsc',
    label: 'LCSC',
    exportHint: 'LCSC → Order details / cart → Export, or the LCSC BOM CSV.',
    // "LCSC Part Number" (the C-prefixed catalogue code) appears in every LCSC order
    // and BOM export and in no other tool's, so one column identifies the source.
    signature: ['lcscpartnumber'],
    rules: [
      // LCSC's own exports have no "name" column, so the manufacturer part number —
      // what a maker actually calls the part — becomes the item name. `name` is kept as
      // a fallback key because a hand-kept parts sheet that merely *carries* an LCSC
      // column still trips this source's signature; without it every such row would
      // fold its own name into the notes and fail as "Row has no name".
      {
        keys: ['manufacturepartnumber', 'manufacturerpartnumber', 'mfrpartnumber', 'name'],
        target: 'name',
      },
      // The LCSC catalogue code is a distributor SKU and takes the identifier slot,
      // where it also serves as the stable match key when a later order re-imports the
      // same part.
      { keys: ['lcscpartnumber', 'lcscpart'], target: 'sku' },
      { keys: ['description'], target: 'description' },
      { keys: ['manufacturer', 'brand'], target: 'manufacturer' },
      { keys: ['orderqty', 'quantity', 'qty'], target: 'quantity' },
      // The per-unit price only — "Order Price" is the line total and is folded instead.
      // LCSC heads this column "Unit Price", "Unit Price($)" or "Unit Price(USD)"; the
      // first two both normalise to `unitprice`, the third needs its own key.
      { keys: ['unitprice', 'unitpriceusd', 'price'], target: 'unitCost' },
    ],
  },
];

const SPEC_BY_ID = new Map(MIGRATION_SPECS.map((s) => [s.id, s] as const));

/** All source ids, in the order the picker should list them. */
export const MIGRATION_SOURCE_IDS: readonly MigrationSourceId[] = MIGRATION_SPECS.map((s) => s.id);

/** Human label for each source (for the picker UI). */
export const MIGRATION_SOURCE_LABELS: Record<MigrationSourceId, string> = Object.fromEntries(
  MIGRATION_SPECS.map((s) => [s.id, s.label]),
) as Record<MigrationSourceId, string>;

/** "How to export" hint for each source (for the UI + docs). */
export const MIGRATION_SOURCE_HINTS: Record<MigrationSourceId, string> = Object.fromEntries(
  MIGRATION_SPECS.map((s) => [s.id, s.exportHint]),
) as Record<MigrationSourceId, string>;

// ---------------------------------------------------------------------------
// Auto-detection
// ---------------------------------------------------------------------------

/**
 * Identify the migration source of a header row by its signature columns, or `null`
 * when no source matches unambiguously. Each source's signature is a set of columns
 * unique to that tool's export, so at most one can match.
 */
export function detectMigrationSource(header: readonly string[]): MigrationSourceId | null {
  const keys = new Set(header.map(normaliseKey));
  for (const spec of MIGRATION_SPECS) {
    if (spec.signature.every((s) => keys.has(s))) return spec.id;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Row reshaping
// ---------------------------------------------------------------------------

/** The reshaped matrix + explicit mapping the shared pipeline consumes. */
export interface MigrationOutput {
  /** Human-readable column labels (for the preview / mapping UI). */
  readonly headerRow: string[];
  /** Reshaped data rows, aligned to {@link headerRow}. */
  readonly dataRows: string[][];
  /** Explicit column → field mapping, so the pipeline never re-infers headers. */
  readonly mapping: ColumnMapping;
}

/** Resolve a normalised column key to its target field for a spec (first rule wins). */
function targetFor(spec: MigrationSpec, key: string): CatalogField | null {
  for (const rule of spec.rules) {
    if (rule.keys.includes(key)) return rule.target;
  }
  return null;
}

/**
 * Compose a row's `notes` cell: the source's own notes (if it had a notes column),
 * followed by a provenance block folding every *unrecognised*, non-empty source column
 * as `Header: value`, so nothing is dropped and the origin is clear.
 */
function composeNotes(
  row: readonly string[],
  spec: MigrationSpec,
  nativeNotesIndex: number,
  extraIndices: readonly number[],
  header: readonly string[],
): string {
  const parts: string[] = [];
  const native = nativeNotesIndex >= 0 ? (row[nativeNotesIndex] ?? '').trim() : '';
  if (native.length > 0) parts.push(native);

  const folded: string[] = [];
  for (const i of extraIndices) {
    const value = (row[i] ?? '').trim();
    if (value.length === 0) continue;
    const label = (header[i] ?? '').trim() || `Column ${i + 1}`;
    folded.push(`${label}: ${value}`);
  }
  if (folded.length > 0) parts.push(`Imported from ${spec.label}:\n${folded.join('\n')}`);

  return parts.join('\n\n');
}

/**
 * Reshape a parsed export from `sourceId` into the canonical Gubbins field matrix.
 *
 * Recognised columns become canonical fields (each target claimed once, first column
 * wins); asset-oriented sources with no quantity column gain a synthetic quantity of 1;
 * and every remaining column is folded into a single provenance `notes` column. The
 * returned `mapping` is explicit, so {@link buildImportPlanFromRows} maps by it directly
 * rather than re-inferring from the (now human-readable) headers.
 */
export function mapMigration(
  sourceId: MigrationSourceId,
  header: readonly string[],
  rows: readonly (readonly string[])[],
): MigrationOutput {
  const spec = SPEC_BY_ID.get(sourceId);
  if (!spec) return { headerRow: [...header], dataRows: rows.map((r) => [...r]), mapping: [] };

  // Assign each source column a target field (first-wins per target), leaving the rest
  // as "extras" to fold. The notes column is handled specially (computed, not copied).
  const assigned = new Set<CatalogField>();
  const targetByIndex: (CatalogField | null)[] = header.map(() => null);
  for (let i = 0; i < header.length; i += 1) {
    const target = targetFor(spec, normaliseKey(header[i] ?? ''));
    if (target !== null && !assigned.has(target)) {
      assigned.add(target);
      targetByIndex[i] = target;
    }
  }

  const nativeNotesIndex = targetByIndex.findIndex((t) => t === 'notes');
  const extraIndices = header.map((_, i) => i).filter((i) => targetByIndex[i] === null);

  // Build the output columns: recognised copy-columns in source order (excluding the
  // notes column), an optional synthetic quantity for asset sources, then the single
  // provenance notes column at the end.
  const headerRow: string[] = [];
  const mapping: (CatalogField | null)[] = [];
  const copyIndices: number[] = [];
  for (let i = 0; i < header.length; i += 1) {
    const target = targetByIndex[i];
    if (target == null || target === 'notes') continue;
    headerRow.push(CATALOG_FIELD_LABELS[target]);
    mapping.push(target);
    copyIndices.push(i);
  }

  const synthesiseQuantity = spec.assetLike === true && !assigned.has('quantity');
  if (synthesiseQuantity) {
    headerRow.push(CATALOG_FIELD_LABELS.quantity);
    mapping.push('quantity');
  }

  headerRow.push(CATALOG_FIELD_LABELS.notes);
  mapping.push('notes');

  const dataRows = rows.map((row) => {
    const out: string[] = copyIndices.map((i) => (row[i] ?? '').trim());
    if (synthesiseQuantity) out.push('1');
    out.push(composeNotes(row, spec, nativeNotesIndex, extraIndices, header));
    return out;
  });

  return { headerRow, dataRows, mapping };
}
