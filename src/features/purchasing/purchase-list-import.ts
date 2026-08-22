/**
 * Purchase-list import parsing (issue #34).
 *
 * Turns a list of things to buy — a supplier basket export, a quote, a spreadsheet of parts,
 * or a plain typed shopping list — into structured {@link ParsedPurchaseListLine}s that can be
 * landed on **either** purchasing surface: as lines on a purchase order, or as entries on the
 * wishlist. One parse feeds both, so the two destinations can never disagree about what the
 * file said.
 *
 * Nothing about reading the input is re-implemented here: format detection, the RFC-4180 codec
 * and the JSON / Markdown / HTML table parsers come from the shared
 * {@link module:features/import/tabular} engine, and the header matching + cell coercion come
 * from {@link module:features/import/columns} — the same layers the item catalogue and project
 * BOM importers sit on.
 *
 * Where this differs from the BOM importer is the *vocabulary*, and that difference is the
 * whole reason it exists: a BOM line is a designator and a part matched against inventory,
 * whereas a purchase line carries **price**, a **supplier** and an optional **link** — the
 * fields a purchase order and a wishlist entry need and a BOM has no place for. It also accepts
 * a free-form list (one thing per line), which a BOM never is.
 *
 * Kept pure (no DB, no React) so it unit-tests instantly. Matching a line to a local item by
 * MPN/SKU is performed by `ItemRepository.findByMatchKey` at import time, as for a BOM.
 */
import {
  detectImportFormat,
  extractTableRows,
  isTabularFormat,
  type ImportFormat,
} from '@/features/import/tabular';
import {
  cellAt,
  cellAsAmount,
  mapColumns,
  problemExcerpt,
  readCountCell,
  textCellProblem,
  type ColumnSynonyms,
  type ImportRowProblem,
} from '@/features/import/columns';
import { TEXT_LIMITS } from '@/lib/text-limits';
import type { WishlistEntryDraft } from './wishlist';

/** A single row parsed from a purchase list, before it is landed on either surface. */
export interface ParsedPurchaseListLine {
  /** The thing being bought, as named by the source (a description or product title). */
  readonly name: string | null;
  /** Manufacturer part number, when the source names one. */
  readonly mpn: string | null;
  /** The supplier's own order code / SKU, when the source names one. */
  readonly supplierSku: string | null;
  /**
   * The supplier / vendor / store the line is to be bought from, **as a name**.
   *
   * Suppliers are a first-class entity (issue #384), but a parsed line deliberately keeps
   * carrying a name rather than an id: an imported file only ever contains what someone typed
   * into a spreadsheet, and this module is pure — it has no database to look an id up in. The
   * name is resolved onto an existing supplier, or used to create one, at *write* time by
   * `SupplierRepository.resolveOrCreate`, which folds case, spacing and punctuation. So an
   * import can no more mint a near-duplicate supplier than the picker can, and the parser
   * stays a pure text-to-structure function.
   */
  readonly supplierName: string | null;
  /**
   * How many to buy. Always a positive whole number — it becomes an order line's
   * `ordered_qty`, which the database requires to be greater than zero. It defaults to 1 only
   * when the source supplied no quantity at all; a row stating a quantity that cannot be
   * ordered is left out and reported instead (issue #350).
   */
  readonly quantity: number;
  /**
   * Price for **one** unit, or `null` when the source gave no usable price. Derived from a
   * line-total column when only a total was supplied (see {@link parsePurchaseList}).
   */
  readonly unitPrice: number | null;
  /** A product link, when the source carries one. Sanitised at the point of use, not here. */
  readonly url: string | null;
  /** Any free-text note against the line. */
  readonly note: string | null;
  /** A raw priority hint, normalised by the wishlist seam when landed there. */
  readonly priority: string | null;
}

/** The outcome of parsing a purchase list: the lines to land, plus the rows that could not become one. */
export interface PurchaseListParseResult {
  readonly lines: readonly ParsedPurchaseListLine[];
  /** Rows the file described whose quantity could not be ordered — listed in the preview. */
  readonly problems: readonly ImportRowProblem[];
}

/** Raised when a purchase list is empty or carries nothing that could name a thing to buy. */
export class PurchaseListImportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PurchaseListImportError';
  }
}

/** The logical columns a purchase line is built from. */
type LogicalColumn =
  | 'name'
  | 'mpn'
  | 'supplierSku'
  | 'supplierName'
  | 'quantity'
  | 'unitPrice'
  | 'totalPrice'
  | 'url'
  | 'note'
  | 'priority';

/**
 * Header synonyms (already in `headerKey` form) → logical column.
 *
 * The ordering within each list is irrelevant (the *header's* left-to-right order decides
 * which cell wins), but the split between `mpn` and `supplierSku` matters: a bare
 * `"partnumber"` is treated as a manufacturer part number, while explicitly supplier-flavoured
 * codes (`"ordercode"`, `"suppliersku"`) bind to the SKU. Both are tried as match keys at
 * import time, so a mis-guess costs nothing.
 */
const COLUMN_SYNONYMS: ColumnSynonyms<LogicalColumn> = {
  name: ['name', 'item', 'description', 'product', 'productname', 'title', 'part', 'partname', 'comment'],
  mpn: [
    'mpn',
    'manufacturerpartnumber',
    'mfrpartnumber',
    'mfgpartnumber',
    'manufacturerpartno',
    'partnumber',
    'mfrpn',
    'mfgpn',
  ],
  supplierSku: [
    'sku',
    'suppliersku',
    'supplierpartnumber',
    'supplierpartno',
    'ordercode',
    'itemcode',
    'stockcode',
  ],
  supplierName: ['supplier', 'vendor', 'seller', 'store', 'shop', 'merchant', 'distributor'],
  quantity: ['quantity', 'qty', 'qnty', 'count', 'amount', 'units'],
  unitPrice: ['unitprice', 'unitcost', 'price', 'cost', 'priceeach', 'each', 'ppu', 'priceperunit'],
  totalPrice: ['total', 'totalprice', 'totalcost', 'linetotal', 'subtotal', 'extendedprice', 'lineprice'],
  url: ['url', 'link', 'href', 'productlink', 'producturl', 'weblink'],
  note: ['note', 'notes', 'remark', 'remarks', 'memo'],
  priority: ['priority', 'urgency', 'importance'],
};

/** The error message shown when the input carries no column a purchase line can be built from. */
const NO_COLUMNS_MESSAGE =
  'No recognisable purchase-list columns found. Expected a header with Name/Description ' +
  '(or MPN / SKU), and optionally Quantity, Price and Link. If this is a plain list rather ' +
  'than a table, set “Interpret as” to “Line list”.';

/** The error message shown when the input has a usable shape but every row is blank. */
const NO_ROWS_MESSAGE = 'No lines found — every row was blank.';

/**
 * A free-form line with a leading or trailing quantity, e.g. `"3x M3 bolts"`, `"3 × M3 bolts"`,
 * `"3 M3 bolts"` or `"M3 bolts x3"`. Captured so a typed shopping list gets its quantities
 * without the user having to build a table.
 */
const LEADING_QTY_RE = /^(\d+)\s*(?:[x×*]\s*|\s)(.+)$/i;
const TRAILING_QTY_RE = /^(.+?)\s*[x×*]\s*(\d+)$/i;

/** Strip a common list bullet (`-`, `*`, `•`, `1.`) from the front of a free-form line. */
function stripBullet(line: string): string {
  return line.replace(/^\s*(?:[-*•·]|\d+[.)])\s+/, '').trim();
}

/**
 * Parse one free-form line into a name + quantity. A leading count wins over a trailing one,
 * because `"2x Widget x4"` almost certainly means two of a product whose name ends in "x4".
 *
 * A count of `0` is returned as `0` rather than being passed over: `"0 tea towels"` states a
 * quantity as plainly as a spreadsheet column does, and the caller leaves that line out and
 * says so instead of buying one (issue #350).
 */
function parseFreeFormLine(raw: string): { name: string; quantity: number } | null {
  const text = stripBullet(raw);
  if (text.length === 0) return null;

  const leading = LEADING_QTY_RE.exec(text);
  if (leading) {
    const quantity = Number.parseInt(leading[1]!, 10);
    const name = leading[2]!.trim();
    if (name.length > 0) return { name, quantity };
  }

  const trailing = TRAILING_QTY_RE.exec(text);
  if (trailing) {
    const quantity = Number.parseInt(trailing[2]!, 10);
    const name = trailing[1]!.trim();
    if (name.length > 0) return { name, quantity };
  }

  return { name: text, quantity: 1 };
}

/** Options for {@link parsePurchaseList}. */
export interface ParsePurchaseListOptions {
  /**
   * Force a specific source format, bypassing auto-detection (mirrors the item and BOM
   * importers' "Interpret as"). Unlike a BOM, `'lines'` is a legitimate choice here — a
   * purchase list is very often just one thing typed per line.
   */
  readonly format?: ImportFormat;
  /**
   * Whether the first row of a *delimited* source is a header row. Defaults to `true`.
   * Ignored for the structured formats and for a free-form list.
   */
  readonly hasHeader?: boolean;
}

/**
 * Parse a purchase list into structured lines.
 *
 * The source format is auto-detected (CSV/SSV/TSV, JSON, a Markdown table, an HTML table, or a
 * free-form list) — or forced via `options.format`. Tabular input is reduced to a header +
 * data-row matrix by the shared engine and mapped through the header synonyms above; free-form
 * input becomes one line per row, honouring a leading/trailing quantity (`"3x M3 bolts"`).
 *
 * A quantity is only defaulted to 1 where the file supplied none (no column, or a blank cell).
 * A quantity the file *did* state but that cannot be ordered — a `0` marking a de-selected
 * basket row, a negative, a fraction, or text that is not a number — leaves its row out and is
 * reported in {@link PurchaseListParseResult.problems}, rather than being quietly promoted to
 * one unit the user never asked to buy (issue #350).
 *
 * When a row carries a line **total** but no unit price, the unit price is derived by dividing
 * by the quantity — supplier basket exports commonly give only the extended price.
 *
 * Throws {@link PurchaseListImportError} when the input is empty, carries no column a line
 * could be built from, or yields no usable rows.
 */
export function parsePurchaseList(
  text: string,
  options: ParsePurchaseListOptions = {},
): PurchaseListParseResult {
  if (text.trim().length === 0) {
    throw new PurchaseListImportError('The purchase list is empty.');
  }

  const format: ImportFormat = options.format ?? detectImportFormat(text);

  if (!isTabularFormat(format)) {
    return parseFreeFormList(text);
  }

  const extraction = extractTableRows(text, {
    format,
    ...(options.hasHeader !== undefined ? { hasHeader: options.hasHeader } : {}),
  });

  // A structured parse failed (malformed JSON, no table found): surface the column guidance
  // rather than the engine's generic note, so the user is told what a purchase list needs.
  if (extraction.note !== undefined || extraction.headerRow.length === 0) {
    throw new PurchaseListImportError(NO_COLUMNS_MESSAGE);
  }

  const columns = mapColumns(extraction.headerRow, COLUMN_SYNONYMS);

  // At least one column that can *name* the thing being bought is required — a table of bare
  // quantities and prices describes no purchase. Reading it as a free-form list instead would
  // quietly turn each row into a nonsense entry, so this fails and names the way out: a list
  // that only *looks* tabular (a comma in every line) can be forced to "Line list".
  if (columns.name === undefined && columns.mpn === undefined && columns.supplierSku === undefined) {
    throw new PurchaseListImportError(NO_COLUMNS_MESSAGE);
  }

  const lines: ParsedPurchaseListLine[] = [];
  const problems: ImportRowProblem[] = [];
  for (const [index, row] of extraction.dataRows.entries()) {
    const name = cellAt(row, columns.name);
    const mpn = cellAt(row, columns.mpn);
    const supplierSku = cellAt(row, columns.supplierSku);
    if (!name && !mpn && !supplierSku) continue; // blank row — nothing to buy

    // Bounded for the same reason as the BOM importer's cells (issue #346): an over-long value
    // left to the column CHECK would abort the write half-way down the file.
    const overLong =
      textCellProblem(name, TEXT_LIMITS.line) ??
      textCellProblem(mpn, TEXT_LIMITS.line) ??
      textCellProblem(supplierSku, TEXT_LIMITS.line) ??
      textCellProblem(cellAt(row, columns.supplierName), TEXT_LIMITS.line) ??
      textCellProblem(cellAt(row, columns.url), TEXT_LIMITS.url) ??
      textCellProblem(cellAt(row, columns.note), TEXT_LIMITS.note);
    if (overLong) {
      problems.push({
        sourceRow: index + 1,
        // Excerpted, because the label may itself be the over-long cell.
        label: problemExcerpt(name ?? mpn ?? supplierSku ?? ''),
        ...overLong,
      });
      continue;
    }

    // `zeroAllowed: false`: an order line for zero units cannot exist, and a basket export
    // writes 0 for a row the user de-selected — so the row is left out and named, never
    // rounded up to one.
    const quantity = readCountCell(row, columns.quantity, { fallback: 1, zeroAllowed: false });
    if (!quantity.ok) {
      problems.push({
        sourceRow: index + 1,
        // One of these is non-null: a row with none of them was skipped as blank above.
        label: name ?? mpn ?? supplierSku ?? '',
        reason: quantity.reason,
        value: quantity.value,
      });
      continue;
    }

    const unitPrice = cellAsAmount(row, columns.unitPrice);
    const totalPrice = cellAsAmount(row, columns.totalPrice);

    lines.push({
      name,
      mpn,
      supplierSku,
      supplierName: cellAt(row, columns.supplierName),
      quantity: quantity.value,
      // Only a *supplied* total is divided down; a missing total leaves the price unknown
      // rather than inventing a zero.
      unitPrice: unitPrice ?? (totalPrice !== null ? totalPrice / quantity.value : null),
      url: cellAt(row, columns.url),
      note: cellAt(row, columns.note),
      priority: cellAt(row, columns.priority),
    });
  }

  // Every row being *left out* is not the same as every row being blank: the caller shows the
  // problems, so failing the whole parse here would replace that explanation with a wrong one.
  if (lines.length === 0 && problems.length === 0) {
    throw new PurchaseListImportError(NO_ROWS_MESSAGE);
  }
  return { lines, problems };
}

/** Parse a free-form list (one thing per line) into purchase lines. */
function parseFreeFormList(text: string): PurchaseListParseResult {
  const lines: ParsedPurchaseListLine[] = [];
  const problems: ImportRowProblem[] = [];
  for (const [index, raw] of text.split(/\r\n|\r|\n/).entries()) {
    const parsed = parseFreeFormLine(raw);
    if (!parsed) continue;
    if (parsed.quantity === 0) {
      // The row numbering is the line number as pasted, which is what the user can look at.
      problems.push({ sourceRow: index + 1, label: parsed.name, reason: 'zero', value: '0' });
      continue;
    }
    lines.push({
      name: parsed.name,
      mpn: null,
      supplierSku: null,
      supplierName: null,
      quantity: parsed.quantity,
      unitPrice: null,
      url: null,
      note: null,
      priority: null,
    });
  }
  if (lines.length === 0 && problems.length === 0) {
    throw new PurchaseListImportError(NO_ROWS_MESSAGE);
  }
  return { lines, problems };
}

/**
 * The human label for a parsed line — what the user sees in the preview, and what is written
 * as a purchase-order line's description or a wishlist entry's name. Falls back through the
 * identifying columns so a list of bare part numbers still produces something readable.
 */
export function purchaseLineLabel(line: ParsedPurchaseListLine): string {
  return line.name ?? line.mpn ?? line.supplierSku ?? 'Unnamed line';
}

/**
 * The keys used to auto-match a parsed line to a local item, in the order they should be
 * tried — empty when the line carries no identifier at all. The MPN goes first (as for a BOM),
 * then the supplier's own code; both are resolved by `ItemRepository.findByMatchKey`, which
 * looks at an item's MPN and its aliases.
 */
export function purchaseLineMatchKeys(line: ParsedPurchaseListLine): string[] {
  return [line.mpn, line.supplierSku].filter((key): key is string => key !== null);
}

/**
 * Adapt a parsed line to a wishlist entry draft. The unit price becomes the entry's target
 * price (what the user expects to pay for one), and the supplier — which the wishlist has no
 * column for — is folded into the note so the information is not silently dropped. The link and
 * priority are passed through raw; `planWishlistEntry` sanitises the URL and softens an
 * unrecognised priority to `NONE`.
 */
export function toWishlistDraft(line: ParsedPurchaseListLine): WishlistEntryDraft {
  const noteParts = [line.note, line.supplierName ? `Supplier: ${line.supplierName}` : null].filter(
    (part): part is string => part !== null,
  );
  return {
    name: purchaseLineLabel(line),
    note: noteParts.length > 0 ? noteParts.join(' · ') : null,
    url: line.url,
    targetPrice: line.unitPrice,
    priority: line.priority,
  };
}
