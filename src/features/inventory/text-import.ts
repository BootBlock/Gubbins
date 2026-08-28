/**
 * Generalised item-import engine (Phase: generalised import dialog).
 *
 * Turns arbitrary user input — a pasted/typed block of text, or the contents of an
 * uploaded file — into the same dry-run {@link CatalogImportPlan} the catalogue CSV
 * importer already produces, so a single "map → preview → apply" pipeline serves
 * every input method and every recognised shape of data.
 *
 * The generic "text → header + data-row matrix" machinery — format detection, the
 * RFC-4180 codec and the JSON / Markdown / HTML table parsers — lives in the shared,
 * item-agnostic {@link module:features/import/tabular} engine (also used by the projects
 * BOM importer). This module layers the **item-specific** parts on top: the column
 * mapping to {@link CatalogField}s, custom-field auto-mapping, tool migrations, and the
 * free-form **`lines`** shape (best-effort quantity / SKU / ASIN / price extraction).
 *
 * Recognised source shapes (auto-detected, or forced via the dialog's "Interpret as"):
 *   - `'csv'` / `'ssv'` / `'tsv'` — delimiter-separated values.
 *   - `'json'`     — an array of objects (or `{ items: [...] }`); keys become columns.
 *   - `'markdown'` — a GitHub-flavoured pipe table.
 *   - `'html'`     — an HTML `<table>`.
 *   - `'lines'`    — free-form, one item per line, with best-effort extraction of a
 *                    quantity and SKU from common shorthand ("Resistor 10k x50",
 *                    "50x M3 bolts", "Widget (qty: 12)", "Cap 100nF, sku: C-100"). A
 *                    labelled **weight** (`w:` / `weight:`) is read too — a bare number as
 *                    grams, or with a unit suffix (`2.5kg`, `16oz`, `1.1lb`). An **Amazon
 *                    ASIN or listing URL** ({@link ./asin}), or another recognised
 *                    supplier's order code / listing URL ({@link ./supplier-codes} — LCSC,
 *                    DigiKey, RS Components, Farnell, Adafruit), is read as the SKU, and a
 *                    **currency-marked unit price** (£/$/€/¥) as the unit cost, so a pasted
 *                    invoice / order lands as items with their order code + price.
 *
 * Kept free of React and the DOM for instant unit-test execution.
 */
import {
  detectImportFormat,
  extractTableRows,
  IMPORT_FORMATS,
  IMPORT_FORMAT_LABELS,
  isDelimitedFormat,
  isTabularFormat,
  type ImportFormat,
} from '@/features/import/tabular';
import {
  buildImportPlanFromRows,
  inferColumnMapping,
  type BuildPlanOptions,
  type CatalogImportPlan,
  type ColumnMapping,
} from './catalog-import';
import { findAsin } from './asin';
import { findSupplierCode } from './supplier-codes';
import { mapMigration, type MigrationSourceId } from './importers/migrations';
import { toGrams, type WeightUnit } from '@/lib/weight';
import type { CategoryField, Item } from '@/db/repositories/types';

// Re-export the shared format model so existing importers (ImportDataDialog) keep a single
// import site — the detection/codec/parsers moved to features/import/tabular, but the item
// dialog still reaches them through this module.
export {
  detectImportFormat,
  IMPORT_FORMATS,
  IMPORT_FORMAT_LABELS,
  isDelimitedFormat,
  isTabularFormat,
  type ImportFormat,
};

// ---------------------------------------------------------------------------
// Free-form line parsing
// ---------------------------------------------------------------------------

/**
 * One item recovered from a free-form line. `sku` is always present (null when
 * unlabelled); the batch-oriented `manufacturer` / `location` / `trackingMode`
 * fields are only present when the line labels them, so a bare name stays the
 * minimal `{ name, quantity, sku }` shape.
 */
export interface FreeformItem {
  readonly name: string;
  /** Extracted quantity; defaults to 1 when none is recognised. */
  readonly quantity: number;
  /** Extracted SKU / part number, or `null` when none was labelled. */
  readonly sku: string | null;
  /** Labelled manufacturer (`manu:` / `manufacturer:`), when present. */
  readonly manufacturer?: string;
  /** Labelled location *name* (`loc:` / `location:`), when present. */
  readonly location?: string;
  /** Labelled tracking mode (`track:` / `tracking:`) — enum or label, when present. */
  readonly trackingMode?: string;
  /** A currency-marked unit price recovered from the line (e.g. `£12.99`), when present. */
  readonly unitCost?: number;
  /**
   * Labelled weight in canonical **grams** (`weight:` / `w:`), when present. A bare number is
   * read as grams; a unit suffix (`kg` / `g` / `oz` / `lb`, or their long forms) converts to
   * grams, e.g. `w: 2.5kg` → 2500. Absent when the line labels no weight.
   */
  readonly weight?: number;
}

/** Parse a non-negative integer, or `null` if the text is not a clean integer. */
function toCount(text: string): number | null {
  const n = Number.parseInt(text, 10);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/** The logical fields an inline `key: value` label can target. */
type LabelField = 'sku' | 'manufacturer' | 'location' | 'trackingMode' | 'quantity' | 'weight';

/**
 * Recognised weight-unit words for a free-form `weight:` / `w:` value, mapped to the canonical
 * {@link WeightUnit}. A bare number (no suffix) is read as grams — the canonical storage unit —
 * so `w:500` is 500 g and `w:2.5kg` is 2500 g.
 */
const WEIGHT_UNIT_WORDS: Readonly<Record<string, WeightUnit>> = {
  g: 'g',
  gram: 'g',
  grams: 'g',
  kg: 'kg',
  kgs: 'kg',
  kilo: 'kg',
  kilos: 'kg',
  kilogram: 'kg',
  kilograms: 'kg',
  oz: 'oz',
  ounce: 'oz',
  ounces: 'oz',
  lb: 'lb',
  lbs: 'lb',
  pound: 'lb',
  pounds: 'lb',
};

/**
 * Parse a free-form weight value into canonical **grams**, or `null` when it is not a weight.
 * Accepts a leading number (locale-aware via `decimalSeparator`) with an optional unit suffix —
 * `500`, `2.5kg`, `16 oz`, `1.1 lb`, `750 grams`. A bare number is grams; an unrecognised unit
 * word yields `null` (so stray text is never stored as a weight). Trailing text after the
 * number+unit is ignored.
 */
function parseWeightToGrams(value: string, decimalSeparator: string): number | null {
  const m = value.trim().match(/^(\d[\d.,]*\d|\d)\s*([a-z]+)?/i);
  if (!m) return null;
  const num = parseLocaleAmount(m[1]!, decimalSeparator);
  if (num === null || num < 0) return null;
  const unitWord = (m[2] ?? '').toLowerCase();
  const unit = unitWord === '' ? 'g' : WEIGHT_UNIT_WORDS[unitWord];
  if (unit === undefined) return null;
  return toGrams(num, unit);
}

/**
 * Recognised inline labels, matched anywhere in a line as `key: value` (also `=` or
 * `#` as the separator). A label's value runs to the start of the *next* label, or to
 * the end of the line — so multi-word values (a manufacturer, a location name) are
 * captured whole. Single-token fields (SKU, tracking) keep only the first token of
 * their value and integer fields (quantity) keep the first number, so any trailing
 * shorthand is not swallowed.
 *
 * Longest alternatives are listed first, and every keyword must be followed by a
 * separator, so `q:` never shadows `quantity:`, `weight:` is never shortened to the `w`
 * keyword, and a word like "Manual" (no colon) is never mistaken for `manu:`.
 */
const LABEL_SCAN =
  /\b(weight|manufacturer|manu|location|loc|tracking|track|quantity|qty|sku|mpn|p\/n|pn|part\s*(?:no\.?|number)?|count|amount|q|w)\s*[:=#]/gi;

/** Map a matched label keyword to its logical {@link LabelField}. */
function labelFieldOf(keyword: string): LabelField {
  const k = keyword.toLowerCase().replace(/\s+/g, ' ').trim();
  if (k === 'manufacturer' || k === 'manu') return 'manufacturer';
  if (k === 'location' || k === 'loc') return 'location';
  if (k === 'tracking' || k === 'track') return 'trackingMode';
  if (k === 'quantity' || k === 'qty' || k === 'q' || k === 'count' || k === 'amount') return 'quantity';
  if (k === 'weight' || k === 'w') return 'weight';
  return 'sku'; // sku / mpn / pn / p/n / part…
}

/** A leading multiplier: "50x Widget", "50 × Widget", "50 * Widget". */
const LEADING_QTY = /^\s*(\d+)\s*[x×*]\s+/i;

/**
 * Trailing quantity shorthands, tried in order. Each captures the count in group 1
 * and, crucially, is anchored to the end of the (label-stripped) line so removing the
 * match leaves a clean name.
 */
const TRAILING_QTY_PATTERNS: readonly RegExp[] = [
  // "… x50", "… × 50", "… *50" (a space must precede the multiplier)
  /\s[x×*]\s*(\d+)\s*$/i,
  // "… [50]" / "… (50)"
  /\s*[([]\s*(\d+)\s*[)\]]\s*$/,
  // "…, 50" / "…\t50"
  /[,\t]\s*(\d+)\s*$/,
];

/** Strip leading / trailing separator punctuation left behind after extraction. */
function cleanName(text: string): string {
  return text
    .replace(/^[\s,;:\-–—|]+/, '')
    .replace(/[\s,;:\-–—|]+$/, '')
    .trim();
}

/** The first whitespace-delimited token of a value, or `null` when it is blank. */
function firstToken(value: string): string | null {
  const token = value.trim().split(/\s+/)[0];
  return token && token.length > 0 ? token : null;
}

/** The labelled fields pulled from a line, plus the leading "head" before them. */
interface LabelledFields {
  readonly head: string;
  readonly sku: string | null;
  readonly manufacturer: string | null;
  readonly location: string | null;
  readonly trackingMode: string | null;
  readonly quantity: number | null;
  /** Labelled weight in canonical grams, or `null` when none is labelled. */
  readonly weight: number | null;
}

/**
 * Extract every inline `key: value` label from a line. The returned `head` is the
 * text before the first label (the item name plus any quantity shorthand); each
 * field holds the first labelled occurrence (first wins). Fields with no label are
 * `null`.
 */
function extractLabelledFields(input: string, decimalSeparator = '.'): LabelledFields {
  const matches = [...input.matchAll(LABEL_SCAN)];
  if (matches.length === 0) {
    return {
      head: input,
      sku: null,
      manufacturer: null,
      location: null,
      trackingMode: null,
      quantity: null,
      weight: null,
    };
  }

  let sku: string | null = null;
  let manufacturer: string | null = null;
  let location: string | null = null;
  let trackingMode: string | null = null;
  let quantity: number | null = null;
  let weight: number | null = null;

  for (let i = 0; i < matches.length; i += 1) {
    const m = matches[i]!;
    const field = labelFieldOf(m[1]!);
    const valueStart = m.index + m[0].length;
    const valueEnd = i + 1 < matches.length ? matches[i + 1]!.index : input.length;
    const value = input.slice(valueStart, valueEnd).trim();

    switch (field) {
      case 'sku':
        sku ??= firstToken(value);
        break;
      case 'manufacturer':
        if (manufacturer === null && value.length > 0) manufacturer = value;
        break;
      case 'location':
        if (location === null && value.length > 0) location = value;
        break;
      case 'trackingMode':
        trackingMode ??= firstToken(value);
        break;
      case 'quantity':
        if (quantity === null) quantity = toCount(value.match(/\d+/)?.[0] ?? '');
        break;
      case 'weight':
        if (weight === null) weight = parseWeightToGrams(value, decimalSeparator);
        break;
    }
  }

  // The head is everything before the first label; drop a dangling opener (e.g. the
  // "(" in "Widget (qty: 5)") so the name does not keep a stray bracket.
  const head = input.slice(0, matches[0]!.index).replace(/[([{]\s*$/, '');
  return { head, sku, manufacturer, location, trackingMode, quantity, weight };
}

/** Pull a shorthand quantity out of the head text, or `null` when none is present. */
function extractQuantityShorthand(input: string): { quantity: number | null; rest: string } {
  const lead = LEADING_QTY.exec(input);
  if (lead) {
    const qty = toCount(lead[1]!);
    if (qty !== null) return { quantity: qty, rest: input.slice(lead[0].length) };
  }
  for (const re of TRAILING_QTY_PATTERNS) {
    const m = re.exec(input);
    if (m && m.index !== undefined) {
      const qty = toCount(m[1]!);
      if (qty !== null) {
        return { quantity: qty, rest: input.slice(0, m.index) + input.slice(m.index + m[0].length) };
      }
    }
  }
  return { quantity: null, rest: input };
}

/**
 * A **currency-marked** amount: a symbol (£/$/€/¥) immediately followed by a run of digits
 * and grouping/decimal separators. Anchoring to a currency symbol keeps this from swallowing
 * a plain number that is really a quantity or part of a part code — a bare `12.99` is
 * deliberately *not* treated as a price. The run must start and end on a digit, so a
 * trailing separator is not captured.
 */
const CURRENCY_AMOUNT_RE = /[£$€¥]\s?(\d[\d.,]*\d|\d)/;

/**
 * Parse a captured amount string (`1,234.56`, `1.234,56`, `5,99`) to a number, using the
 * caller's `decimalSeparator` to disambiguate `.` from `,`. The *other* symbol is treated
 * as the thousands separator and stripped; the decimal separator is normalised to `.`.
 * Returns `null` when the result is not finite.
 */
function parseLocaleAmount(raw: string, decimalSeparator: string): number | null {
  const thousands = decimalSeparator === ',' ? '.' : ',';
  const withoutThousands = raw.split(thousands).join('');
  const normalised =
    decimalSeparator === '.' ? withoutThousands : withoutThousands.replace(decimalSeparator, '.');
  const value = Number.parseFloat(normalised);
  return Number.isFinite(value) ? value : null;
}

/**
 * Pull a currency-marked unit price out of the text, or `null` when none is present.
 * `decimalSeparator` (default `.`) selects how `,`/`.` are read, so a eurozone invoice's
 * `€5,99` parses as `5.99` when the caller passes the user's `,`-decimal locale.
 */
function extractCurrencyPrice(
  input: string,
  decimalSeparator = '.',
): { value: number; matchedText: string } | null {
  const m = CURRENCY_AMOUNT_RE.exec(input);
  if (!m) return null;
  const value = parseLocaleAmount(m[1]!, decimalSeparator);
  if (value === null || value < 0) return null;
  return { value, matchedText: m[0] };
}

/**
 * Best-effort parse of a single free-form line into a {@link FreeformItem}. Returns
 * `null` for a blank line. Inline labels (`sku:`, `manu:`, `loc:`, `track:`, `q:`, `w:`/`weight:`)
 * are extracted first — so a number inside a part code is never mistaken for a quantity —
 * then, from the remaining head text and in order: an **Amazon ASIN / listing URL** as the
 * SKU (unless a `sku:` label already won), a **currency-marked unit price** as the unit
 * cost, and finally a quantity shorthand. Each is stripped so it never leaks into the item
 * name. Quantity defaults to 1 (an item is unlikely to be added with none). A line that
 * reduces to nothing but codes falls back to the ASIN/SKU, then to the raw line, so
 * nothing is dropped. `decimalSeparator` (default `.`) governs how a currency amount's
 * `,`/`.` are read, so a eurozone user's `€5,99` is interpreted as `5.99`.
 *
 * @internal Exported for unit tests only.
 */
export function parseFreeformLine(line: string, decimalSeparator = '.'): FreeformItem | null {
  const trimmed = line.trim();
  if (trimmed.length === 0) return null;

  const labelled = extractLabelledFields(trimmed, decimalSeparator);
  let head = labelled.head;

  // An Amazon ASIN / listing URL, or another recognised supplier's order code / listing
  // URL (see `./supplier-codes`), fills the SKU when the line did not label one — each is
  // a supplier and its code the item's part code (the importer's SKU→MPN slot). The token
  // is stripped from the head either way, so the URL/id never becomes part of the item
  // name even when an explicit `sku:` label takes the SKU slot.
  let sku = labelled.sku;
  const asinFound = findAsin(head);
  if (asinFound) {
    if (sku === null) sku = asinFound.asin;
    head = head.replace(asinFound.matchedText, ' ');
  } else {
    const supplierFound = findSupplierCode(head);
    if (supplierFound) {
      if (sku === null) sku = supplierFound.code;
      head = head.replace(supplierFound.matchedText, ' ');
    }
  }

  // A currency-marked price (e.g. an invoice line's unit price) becomes the unit cost.
  let unitCost: number | undefined;
  const price = extractCurrencyPrice(head, decimalSeparator);
  if (price) {
    unitCost = price.value;
    head = head.replace(price.matchedText, ' ');
  }

  // Always strip a shorthand quantity from the head so it never leaks into the name,
  // but a labelled quantity (`q:`) takes precedence over the shorthand's value.
  const shorthand = extractQuantityShorthand(head);
  const quantity = labelled.quantity ?? shorthand.quantity;
  const rest = shorthand.rest;

  const extras = {
    ...(labelled.manufacturer !== null ? { manufacturer: labelled.manufacturer } : {}),
    ...(labelled.location !== null ? { location: labelled.location } : {}),
    ...(labelled.trackingMode !== null ? { trackingMode: labelled.trackingMode } : {}),
    ...(unitCost !== undefined ? { unitCost } : {}),
    ...(labelled.weight !== null ? { weight: labelled.weight } : {}),
  };

  const name = cleanName(rest);
  if (name.length === 0) {
    // Nothing but codes/price/quantity: name it after the ASIN/SKU, else the raw line.
    const fallback = sku ?? cleanName(trimmed);
    if (fallback.length === 0) return null;
    return { name: fallback, quantity: quantity ?? 1, sku, ...extras };
  }
  return { name, quantity: quantity ?? 1, sku, ...extras };
}

/**
 * Parse a whole block of free-form text into items, one per non-blank line.
 * `decimalSeparator` (default `.`) is passed through to each line's price parsing.
 *
 * @internal Exported for unit tests only.
 */
export function parseFreeformText(text: string, decimalSeparator = '.'): FreeformItem[] {
  const items: FreeformItem[] = [];
  for (const line of text.split(/\r\n|\r|\n/)) {
    const item = parseFreeformLine(line, decimalSeparator);
    if (item) items.push(item);
  }
  return items;
}

// ---------------------------------------------------------------------------
// Extraction — text → row matrix + initial mapping
// ---------------------------------------------------------------------------

/** The canonical columns synthesised for a free-form line list. */
const LINES_HEADER: readonly string[] = [
  'name',
  'quantity',
  'sku',
  'manufacturer',
  'location',
  'tracking',
  'unitCost',
  'weight',
];
const LINES_COLUMNS: readonly string[] = [
  'Name',
  'Quantity',
  'SKU',
  'Manufacturer',
  'Location',
  'Tracking',
  'Unit cost',
  'Weight (g)',
];
const LINES_MAPPING: ColumnMapping = [
  'name',
  'quantity',
  'sku',
  'manufacturer',
  'locationId',
  'trackingMode',
  'unitCost',
  'weight',
];

/** The normalised, parse-ready form of an import: a header + data-row matrix. */
export interface ImportExtraction {
  /** The detected (or caller-forced) source format. */
  readonly format: ImportFormat;
  /** Header cells — real headers for tabular input, synthetic for a line list. */
  readonly headerRow: readonly string[];
  /** Data rows with blank rows removed; index `i` corresponds to source row `i + 1`. */
  readonly dataRows: readonly string[][];
  /** A concrete initial column mapping (inferred for tabular, fixed for a line list). */
  readonly mapping: ColumnMapping;
  /** Column labels for the mapping / preview UI. */
  readonly columns: readonly string[];
  /** `true` when the source is laid out as columns (mapping is meaningful/editable). */
  readonly isTabular: boolean;
  /** A non-fatal note when the text could not be parsed in the chosen format. */
  readonly note?: string;
}

/** Options for {@link extractImport}. */
export interface ExtractImportOptions {
  /** Force a specific format, bypassing {@link detectImportFormat}. */
  readonly format?: ImportFormat;
  /** Category custom-field definitions, so headers can auto-map to a custom field. */
  readonly customFields?: readonly CategoryField[];
  /**
   * Whether the first row of a *delimited* source is a header row. Defaults to `true`.
   * When `false`, synthetic `Column N` headers are used and every row is treated as
   * data (for headerless CSV/TSV pastes). Ignored for non-delimited formats.
   */
  readonly hasHeader?: boolean;
  /**
   * The decimal separator (`.` or `,`) used to read a currency-marked price in a free-form
   * **line list**. Defaults to `.`; the import dialog passes the user's browser-locale
   * separator so a eurozone `€5,99` is read as `5.99`. Ignored for tabular formats.
   */
  readonly decimalSeparator?: string;
}

/**
 * A one-cell header test for {@link detectImportFormat}: does this line name the item's
 * **name** column? It is what separates a single-column CSV — `name` over three part names —
 * from a free-form list of four items, which are otherwise the same shape. Without it the
 * header row imports as an item (issue #408).
 *
 * Deliberately only the name column, though `inferColumnMapping` would resolve `sku`, `notes`,
 * `stock` or a custom field's name just as readily. A lone column of anything *but* the name
 * builds rows with no name, and every one of them is an error the importer cannot create — so
 * promoting such a file would trade one junk item for an import that lands nothing at all. A
 * file headed `sku` stays a line list, exactly as before. No custom field is consulted for the
 * same reason: a custom field can only outrank a core column for a gauge field, and the name
 * is not one, so no catalogue can change this answer.
 */
function isNameHeader(cell: string): boolean {
  return inferColumnMapping([cell])[0] === 'name';
}

/** Assemble a tabular extraction, inferring the initial mapping from the headers. */
function tabularExtraction(
  format: ImportFormat,
  headerRow: readonly string[],
  dataRows: readonly string[][],
  customFields: readonly CategoryField[],
): ImportExtraction {
  return {
    format,
    headerRow,
    dataRows,
    mapping: inferColumnMapping(headerRow, customFields),
    columns: headerRow,
    isTabular: true,
  };
}

/** An empty tabular extraction carrying a parse note (e.g. malformed JSON). */
function emptyExtraction(format: ImportFormat, note: string): ImportExtraction {
  return { format, headerRow: [], dataRows: [], mapping: [], columns: [], isTabular: true, note };
}

/**
 * Normalise raw import text into a {@link ImportExtraction}: detect (or accept) the
 * format, parse it into a header + data-row matrix, and derive a concrete initial
 * column mapping. Tabular input (delegated to the shared {@link extractTableRows}) keeps
 * its headers and auto-infers the mapping; a free-form line list is flattened to fixed
 * `name / quantity / sku …` columns. Never throws — an unparseable structured format
 * yields an empty extraction with a `note`.
 */
export function extractImport(text: string, options: ExtractImportOptions = {}): ImportExtraction {
  const customFields = options.customFields ?? [];
  const format = options.format ?? detectImportFormat(text, { isHeaderCell: isNameHeader });

  if (format === 'lines') {
    // A line list defaults each item to quantity 1 (a new item is unlikely to be
    // added with none) and carries any inline manufacturer / location / tracking
    // through to the shared plan builder via the synthetic columns.
    const dataRows = parseFreeformText(text, options.decimalSeparator).map((item) => [
      item.name,
      String(item.quantity),
      item.sku ?? '',
      item.manufacturer ?? '',
      item.location ?? '',
      item.trackingMode ?? '',
      item.unitCost !== undefined ? String(item.unitCost) : '',
      item.weight !== undefined ? String(item.weight) : '',
    ]);
    return {
      format,
      headerRow: LINES_HEADER,
      dataRows,
      mapping: LINES_MAPPING,
      columns: LINES_COLUMNS,
      isTabular: false,
    };
  }

  // Every other (tabular) shape flows through the shared extraction engine — one codec,
  // one detector, one parser per structured format. A parse failure carries a `note`.
  const table = extractTableRows(text, { format, hasHeader: options.hasHeader ?? true });
  if (table.note) {
    return emptyExtraction(format, table.note);
  }
  return tabularExtraction(format, table.headerRow, table.dataRows, customFields);
}

// ---------------------------------------------------------------------------
// Migration mapping (Phase EI-3)
// ---------------------------------------------------------------------------

/**
 * Reshape a tabular {@link ImportExtraction} through a named migration mapper (Homebox,
 * Grocy, …) so another tool's export columns become the canonical Gubbins fields the
 * shared plan builder understands. A no-op for a free-form line list or an empty
 * extraction (neither has source columns to remap). The returned extraction carries an
 * *explicit* mapping (`isTabular: true`), so the pipeline maps by it directly rather than
 * re-inferring from the rewritten headers; a `note`, if any, is preserved.
 */
export function applyMigration(extraction: ImportExtraction, source: MigrationSourceId): ImportExtraction {
  if (!extraction.isTabular || extraction.headerRow.length === 0) return extraction;
  const mapped = mapMigration(source, extraction.headerRow, extraction.dataRows);
  return {
    format: extraction.format,
    headerRow: mapped.headerRow,
    dataRows: mapped.dataRows,
    mapping: mapped.mapping,
    columns: mapped.headerRow,
    isTabular: true,
    ...(extraction.note ? { note: extraction.note } : {}),
  };
}

// ---------------------------------------------------------------------------
// Plan building + preview
// ---------------------------------------------------------------------------

/**
 * Build a dry-run {@link CatalogImportPlan} from an {@link ImportExtraction} using the
 * (possibly user-edited) `mapping`. A thin adapter over the shared
 * {@link buildImportPlanFromRows} so callers work in terms of extractions.
 */
export function buildImportPlan(
  extraction: ImportExtraction,
  mapping: ColumnMapping,
  existingItems: readonly Item[],
  options: BuildPlanOptions = {},
): CatalogImportPlan {
  return buildImportPlanFromRows(extraction.headerRow, extraction.dataRows, mapping, existingItems, options);
}

/** The outcome of a single input row, for the "extracted items" preview table. */
export interface ImportPreviewRow {
  /** 1-based source row (data rows only; the header is row 0). */
  readonly sourceRow: number;
  readonly name: string;
  readonly quantity: string;
  readonly sku: string;
  readonly manufacturer: string;
  readonly status: 'create' | 'update' | 'error';
  /** Present when `status === 'error'`. */
  readonly message?: string;
  /**
   * What an `update` row will do to the matched item's on-hand count: what it holds now, and
   * what the file asks for (issue #592). Absent whenever the import will not move the stock —
   * the row states no quantity, states the one the item already holds, or is a create or an
   * error — so the preview can show the raw cell for what it is rather than implying a change.
   */
  readonly quantityChange?: { readonly from: number; readonly to: number };
}

/** First column index whose mapping targets the given core field, or `-1`. */
function indexOfField(mapping: ColumnMapping, field: 'name' | 'quantity' | 'sku' | 'manufacturer'): number {
  return mapping.findIndex((m) => m === field);
}

/**
 * Join the extracted rows with a dry-run plan to produce one preview entry per input
 * row — showing the resolved name / quantity / SKU and whether the row will create,
 * update, or be skipped as an error. This is what the "Import text" tab renders so
 * the user can confirm the extraction looks right before committing.
 *
 * The quantity cell is the file's own, so on a matched row it says what was *asked for*, not
 * what will happen. `quantityChange` carries the second half of that answer — the count the item
 * holds today — for the rows whose stock the import will actually move (issue #592).
 */
export function buildPreviewRows(
  dataRows: readonly (readonly string[])[],
  mapping: ColumnMapping,
  plan: CatalogImportPlan,
): ImportPreviewRow[] {
  const status = new Map<number, { status: ImportPreviewRow['status']; message?: string }>();
  for (const c of plan.create) status.set(c.sourceRow, { status: 'create' });
  for (const u of plan.update) status.set(u.sourceRow, { status: 'update' });
  for (const e of plan.errors) status.set(e.sourceRow, { status: 'error', message: e.message });

  // Only the rows whose stock actually moves, so the preview's quantity column distinguishes
  // "this many will be counted in" from "this is what the cell said" (issue #592).
  const stockChanges = new Map(
    plan.update
      .filter((u) => u.stock !== undefined)
      .map((u) => [u.sourceRow, { from: u.stock!.before, to: u.stock!.counted }] as const),
  );

  const nameIdx = indexOfField(mapping, 'name');
  const qtyIdx = indexOfField(mapping, 'quantity');
  const skuIdx = indexOfField(mapping, 'sku');
  const manuIdx = indexOfField(mapping, 'manufacturer');
  const cell = (row: readonly string[], idx: number) => (idx >= 0 ? (row[idx] ?? '').trim() : '');

  return dataRows.map((row, i) => {
    const sourceRow = i + 1;
    const outcome = status.get(sourceRow) ?? { status: 'error' as const, message: 'Not imported.' };
    return {
      sourceRow,
      name: cell(row, nameIdx),
      quantity: cell(row, qtyIdx),
      sku: cell(row, skuIdx),
      manufacturer: cell(row, manuIdx),
      status: outcome.status,
      ...(outcome.message ? { message: outcome.message } : {}),
      ...(stockChanges.has(sourceRow) ? { quantityChange: stockChanges.get(sourceRow)! } : {}),
    };
  });
}
