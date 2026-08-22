/**
 * Pure aggregation for the **parts catalogue** (issue #22) — a formatted, printable list of
 * items scoped by location, by project, or by an ad-hoc selection, with the reader choosing
 * which columns (cost, supplier, quantity, condition, …) appear. It doubles as an actionable
 * parts list or a plain inventory.
 *
 * Same "logic out of glue" seam as {@link ./insurance-schedule} and `reports.ts`: kept free
 * of React, repositories, SQL and the DOM so the grouping, ordering, per-line valuation and
 * totals are exhaustively unit-tested in isolation. `ReportRepository` resolves the scope to
 * the minimal raw rows and hands them here; the screen renders the returned DTO, showing only
 * the columns the reader selected (the field selection is a *presentation* choice and does not
 * change what this builds — every field is always resolved).
 *
 * Location grouping, hierarchy ordering and the trailing "Unassigned" bucket are shared with
 * the insurance schedule via {@link flattenLocationHierarchy}, so the two documents order
 * rooms identically. Per-unit cost flows through the same {@link valuedUnitValue} seam as every
 * other valuation (a manual cost wins, else the preferred supplier cost — or, for a gauge, its
 * cost per unit of measure, since it holds a measure rather than countable units); an item with
 * none of those is *unpriced* — its cost and line value read as "—" rather than a misleading £0.
 */
import { valuedAmount, valuedUnitValue, type ValuedStock } from './reports';
import {
  flattenLocationHierarchy,
  PRINT_FULL_LIMIT,
  PRINT_PHOTO_LIMIT,
  UNASSIGNED_GROUP_LABEL,
  type ScheduleLocationInput,
} from './insurance-schedule';
import { warrantyStatus, type WarrantyStatus } from '@/features/inventory/asset-lifecycle';
import type { Condition } from '@/db/repositories/constants';

// Re-exported so consumers get the catalogue's "unassigned" heading from one place — the
// grouping/ordering behaviour is shared verbatim with the insurance schedule.
export { UNASSIGNED_GROUP_LABEL } from './insurance-schedule';

/** A location row (id + name + parent), reused from the schedule to order the catalogue. */
export type CatalogueLocationInput = ScheduleLocationInput;

/** The set of columns a reader can choose to print, beyond the always-present item name. */
export type CatalogueFieldKey =
  | 'photo'
  | 'category'
  | 'description'
  | 'quantity'
  | 'condition'
  | 'serial'
  | 'mpn'
  | 'manufacturer'
  | 'supplier'
  | 'unitCost'
  | 'lineValue'
  | 'purchasePrice'
  | 'acquired'
  | 'warranty'
  | 'notes'
  | 'qr';

/** Presentation metadata for one selectable catalogue column. */
export interface CatalogueFieldDef {
  readonly key: CatalogueFieldKey;
  /** Column header text. */
  readonly label: string;
  /** Text alignment — numeric/money columns sit right, everything else left. */
  readonly align: 'left' | 'right';
  /** True when the column shows a money value; a selected money column enables the totals. */
  readonly money?: boolean;
  /**
   * A "media" column (a photo or a scannable code) rather than text — rendered specially and
   * excluded from the plain text-cell path. Repository data (thumbnails) is only fetched when a
   * media column that needs it is on.
   */
  readonly media?: boolean;
  /** Rich-Markdown help: what the column shows and when a reader would want / not want it. */
  readonly help: string;
}

/**
 * The selectable columns, in display order. The item **name** is always the first column and
 * so is not listed here. `lineValue` (quantity × unit cost) is the column that turns the
 * catalogue into a costed parts list and drives the per-group subtotals and grand total.
 * Each column's `help` explains the print/don't-print trade-off for the column picker.
 */
export const CATALOGUE_FIELDS: readonly CatalogueFieldDef[] = [
  {
    key: 'photo',
    label: 'Photo',
    align: 'left',
    media: true,
    help: "The item's primary photo as a thumbnail. **Turn it on** for a visual, customer-facing catalogue so parts are recognisable at a glance; **leave it off** for a compact text list or to save ink. Only items with a photo show one.",
  },
  {
    key: 'category',
    label: 'Category',
    align: 'left',
    help: "The item's category. **Include it** to scan or group the catalogue by type; **leave it out** for a shorter, name-focused list.",
  },
  {
    key: 'description',
    label: 'Description',
    align: 'left',
    help: 'The item description. **Include it** on a customer or reference catalogue where the name alone is not enough; **leave it out** to keep a dense parts list narrow.',
  },
  {
    key: 'quantity',
    label: 'Qty',
    align: 'right',
    help: 'How many are on hand, with the unit of measure. **Include it** for a stock-take or parts list; **leave it out** for a plain reference list where counts do not matter.',
  },
  {
    key: 'condition',
    label: 'Condition',
    align: 'left',
    help: 'The item condition (Mint / Good / …). Useful on a **resale or insurance** list; skip it for a simple parts list where condition is irrelevant.',
  },
  {
    key: 'serial',
    label: 'Serial',
    align: 'left',
    help: 'The serialised instance number. Handy for **asset tracking**; leave it off for bulk consumables that are not individually numbered.',
  },
  {
    key: 'mpn',
    label: 'MPN',
    align: 'left',
    help: 'Manufacturer part number. **Essential on a parts or order list** so a supplier can identify the exact part; unnecessary on a general inventory.',
  },
  {
    key: 'manufacturer',
    label: 'Manufacturer',
    align: 'left',
    help: 'Who makes the item. Useful alongside the MPN on a **procurement** list; often redundant on an internal inventory.',
  },
  {
    key: 'supplier',
    label: 'Supplier',
    align: 'left',
    help: 'Your preferred supplier for the item. **Include it** on a re-order or shopping list; leave it out of a catalogue meant for customers or insurers.',
  },
  {
    key: 'unitCost',
    label: 'Unit cost',
    align: 'right',
    money: true,
    help: 'The effective cost per unit. **Include it** for a costed or quote list; **leave it out** of a customer-facing or asset list where you do not want prices shown.',
  },
  {
    key: 'lineValue',
    label: 'Line value',
    align: 'right',
    money: true,
    help: 'Quantity × unit cost. Turning this on **adds per-location subtotals and a grand total** — ideal for a valuation. Leave it off for a plain list with no money.',
  },
  {
    key: 'purchasePrice',
    label: 'Purchase price',
    align: 'right',
    money: true,
    help: 'What you originally paid per unit. Useful for **insurance or resale**, and distinct from the current unit cost — include it only when the original price matters.',
  },
  {
    key: 'acquired',
    label: 'Acquired',
    align: 'left',
    help: 'When the item was acquired. Relevant to **warranty or depreciation** views; drop it from a general parts list.',
  },
  {
    key: 'warranty',
    label: 'Warranty',
    align: 'left',
    help: 'Warranty status (in warranty / expiring / expired). Useful on an **asset or insurance** schedule; irrelevant to a consumables list.',
  },
  {
    key: 'notes',
    label: 'Notes',
    align: 'left',
    help: 'Free-text notes on the item. **Include** them when they carry handling or usage info; **leave out** if they are private or would clutter the print.',
  },
  {
    key: 'qr',
    label: 'QR',
    align: 'left',
    media: true,
    help: 'A QR code that opens the item in Gubbins when scanned — handy for a warehouse or workshop parts list so anyone can pull up an item from paper. **Leave it off** for a plain or customer-facing catalogue.',
  },
];

/** The columns shown before the reader customises them — a compact, costed default. */
export const DEFAULT_CATALOGUE_FIELDS: readonly CatalogueFieldKey[] = [
  'category',
  'quantity',
  'unitCost',
  'lineValue',
];

/**
 * The set of {@link CatalogueFieldKey}s that carry a money value (drive the totals footer).
 *
 * @internal Exported for unit tests only.
 */
export const CATALOGUE_MONEY_FIELDS: ReadonlySet<CatalogueFieldKey> = new Set(
  CATALOGUE_FIELDS.filter((f) => f.money).map((f) => f.key),
);

/** How the catalogue's sections are grouped. */
export type CatalogueGroupBy = 'location' | 'category' | 'none';
/** How lines are ordered within each section. */
export type CatalogueSortBy = 'name' | 'value' | 'quantity';

/** Selectable grouping options (value + label) for the config picker. */
export const CATALOGUE_GROUP_BY: readonly { readonly value: CatalogueGroupBy; readonly label: string }[] = [
  { value: 'location', label: 'Location' },
  { value: 'category', label: 'Category' },
  { value: 'none', label: 'No grouping' },
];

/** Selectable sort options (value + label) for the config picker. */
export const CATALOGUE_SORT_BY: readonly { readonly value: CatalogueSortBy; readonly label: string }[] = [
  { value: 'name', label: 'Name' },
  { value: 'value', label: 'Value (high to low)' },
  { value: 'quantity', label: 'Quantity (high to low)' },
];

export const DEFAULT_CATALOGUE_GROUP_BY: CatalogueGroupBy = 'location';
export const DEFAULT_CATALOGUE_SORT_BY: CatalogueSortBy = 'name';

/*
 * ---------------------------------------------------------------------------------------
 * Print ceiling (issue #338)
 *
 * The catalogue reads its whole scope in one go and renders every line into one document, so
 * "All items" over a large inventory had nothing standing between the reader and a browser
 * print dialog holding hundreds of pages — and, with the QR column on, one synchronous QR
 * encode per line before it could even open.
 *
 * The insurance schedule — the other printable document, and its peer in every other respect —
 * already draws exactly this line, so the catalogue reuses its ceilings rather than inventing
 * a second, differently-shaped one. A reader who learns the limit on one document has learnt
 * it on both, and the {@link ./Insurance-and-Estate-Schedule} wiki page's wording carries over.
 * ---------------------------------------------------------------------------------------
 */

/**
 * Most catalogue lines that can be rendered into a single printable document (text only).
 *
 * Shared verbatim with the insurance schedule's {@link PRINT_FULL_LIMIT}: both are bounded by
 * what a DOM and a printer will take rather than by what the database can read.
 */
export const CATALOGUE_PRINT_LIMIT = PRINT_FULL_LIMIT;

/**
 * The same ceiling with a **media** column on — the Photo column, whose thumbnails are BLOBs to
 * fetch and `<img>` decodes to wait for, or the QR column, whose codes are one synchronous
 * encode per line. Either binds long before the row count does, so both take the schedule's
 * lower {@link PRINT_PHOTO_LIMIT}.
 */
export const CATALOGUE_PRINT_MEDIA_LIMIT = PRINT_PHOTO_LIMIT;

/**
 * Estimated pages above which printing asks the reader to confirm first.
 *
 * A catalogue under the ceiling can still be a hundred pages, and the browser's own print
 * dialog is the first place that ever became apparent. Twenty pages is about a ream's corner —
 * comfortably more than any everyday parts list, and few enough that a reader who did not mean
 * to print their whole inventory finds out here rather than at the printer.
 */
export const CATALOGUE_CONFIRM_PAGES = 20;

/**
 * The ceiling that applies to a catalogue printing `fields` — the lower media limit whenever a
 * media column (Photo or QR) is among them, else the full text limit.
 */
export function cataloguePrintLimit(fields: ReadonlySet<CatalogueFieldKey>): number {
  const media = CATALOGUE_FIELDS.some((field) => field.media && fields.has(field.key));
  return media ? CATALOGUE_PRINT_MEDIA_LIMIT : CATALOGUE_PRINT_LIMIT;
}

/*
 * Row budgets behind {@link estimateCataloguePages}. Deliberately coarse: the true page count
 * depends on the printer's margins, the reader's paper size and how many lines each cell's text
 * wraps to, none of which is knowable before the print dialog opens. The estimate exists to
 * tell "a couple of pages" from "four hundred", which these are ample for.
 */
/** Table rows an A4 page of the text-only catalogue holds. */
const TEXT_ROWS_PER_PAGE = 40;
/** …with the Photo column on, where a ~13 mm thumbnail sets the row height. */
const PHOTO_ROWS_PER_PAGE = 18;
/** …with the QR column on, whose ~17 mm code is taller still and so wins over a photo. */
const QR_ROWS_PER_PAGE = 13;
/** Rows a section costs beyond its lines: the heading, its totals and the table header. */
const GROUP_ROW_COST = 3;
/** Rows the document's own furniture costs: the letterhead, title band and totals footer. */
const CHROME_ROWS = 6;

/**
 * Roughly how many printed pages a catalogue will run to — what the screen shows beside the
 * Print button so the size of the job is known *before* the browser's print dialog opens
 * (issue #338).
 *
 * Pure and approximate by design (see the row budgets above); never less than one page.
 */
export function estimateCataloguePages(input: {
  /** Lines the document will print. */
  readonly lineCount: number;
  /** Sections the lines are divided into (each costs a heading + a table header). */
  readonly groupCount: number;
  /** The Photo column is on. */
  readonly photos: boolean;
  /** The QR column is on. */
  readonly qr: boolean;
}): number {
  const perPage = input.qr ? QR_ROWS_PER_PAGE : input.photos ? PHOTO_ROWS_PER_PAGE : TEXT_ROWS_PER_PAGE;
  const rows = input.lineCount + input.groupCount * GROUP_ROW_COST + CHROME_ROWS;
  return Math.max(1, Math.ceil(rows / perPage));
}

/** Heading for the trailing bucket of items with no category (when grouping by category). */
export const UNCATEGORISED_GROUP_LABEL = 'Uncategorised';

/**
 * The catalogue **scope**: which items to include. `all` is the whole active catalogue;
 * `location` is a location and its whole subtree; `project` is every item referenced by a
 * project's bill of materials; `items` is an explicit, ad-hoc selection (e.g. the inventory
 * multi-select). The repository owns resolving each to rows.
 */
export type CatalogueScope =
  | { readonly kind: 'all' }
  | { readonly kind: 'location'; readonly locationId: string }
  | { readonly kind: 'project'; readonly projectId: string }
  | { readonly kind: 'items'; readonly itemIds: readonly string[] };

/**
 * One item to place on the catalogue — a minimal, structural slice of `Item` (extends
 * {@link ValuedStock} so it flows through the shared {@link valuedAmount} / {@link
 * valuedUnitValue} seams). Only the fields the document can show are carried, keeping the
 * helper testable.
 */
export interface CatalogueItemInput extends ValuedStock {
  readonly id: string;
  readonly name: string;
  /** The home location the item is grouped under; null/unknown → the "Unassigned" group. */
  readonly locationId: string | null;
  /** Category name, or null when uncategorised. */
  readonly category: string | null;
  /** Free-text description, or null. */
  readonly description: string | null;
  /** Primary thumbnail bytes (opaque passthrough to the UI), or null when the item has no photo. */
  readonly thumbnail: Uint8Array | null;
  /**
   * On-hand quantity; the line value is `quantity × unit cost`. A CONSUMABLE_GAUGE item carries
   * 0 here and is both counted and valued from its contents instead (issue #683).
   */
  readonly quantity: number;
  /** Unit of measure (e.g. `ml`) appended to the quantity, or null. */
  readonly unitOfMeasure: string | null;
  /** Operational condition (Mint/Good/…), or null when untracked. */
  readonly condition: Condition | null;
  /** SERIALISED instance number (1..N), or null for a non-serialised item. */
  readonly serialNo: number | null;
  /** Manufacturer part number, or null. */
  readonly mpn: string | null;
  /** Manufacturer name, or null. */
  readonly manufacturer: string | null;
  /** Preferred supplier's name, or null when none is marked. */
  readonly supplier: string | null;
  /** Original acquisition cost per unit, or null when unpriced. */
  readonly purchasePrice: number | null;
  /** ISO date (`YYYY-MM-DD`) the item was acquired, or null. */
  readonly acquiredAt: string | null;
  /** ISO date the warranty expires, or null; drives the derived warranty status. */
  readonly warrantyExpiresAt: string | null;
  /** Free-text notes, or null. */
  readonly notes: string | null;
}

/** A resolved catalogue line: the display fields plus the derived cost, line value and warranty. */
export interface CatalogueLine {
  readonly id: string;
  readonly name: string;
  /** Home location id (used to group by location; not itself displayed as a column). */
  readonly locationId: string | null;
  readonly category: string | null;
  readonly description: string | null;
  /** Primary thumbnail bytes for the optional Photo column, or null. */
  readonly thumbnail: Uint8Array | null;
  /**
   * The amount on hand — a count for most items, a gauge's contents for a gauge (issue #683).
   * Rendered with {@link CatalogueLine.unitOfMeasure} beside it, so "400 g" and "3" are both
   * unambiguous on the page.
   */
  readonly quantity: number;
  readonly unitOfMeasure: string | null;
  /**
   * Whether {@link CatalogueLine.quantity} is a **measure** rather than a count — true only for
   * a gauge. The "in stock" totals skip these lines: grams and millilitres are not a count, and
   * adding them to one would make the figure a number of nothing (the same refusal the
   * valuation report's unit total makes).
   */
  readonly measured: boolean;
  readonly condition: Condition | null;
  readonly serialNo: number | null;
  readonly mpn: string | null;
  readonly manufacturer: string | null;
  readonly supplier: string | null;
  /** Effective unit cost (manual → preferred supplier), or null when the item is unpriced. */
  readonly unitCost: number | null;
  /** `quantity × unitCost`, or null when the item is unpriced. */
  readonly lineValue: number | null;
  readonly purchasePrice: number | null;
  readonly acquiredAt: string | null;
  readonly warranty: WarrantyStatus;
  readonly notes: string | null;
}

/** A catalogue section (a location, a category, or the single "no grouping" bucket). */
export interface CatalogueGroup {
  /** Stable id of the section (location id, or `category:<name>`), or null for an unresolved/blank bucket. */
  readonly groupId: string | null;
  /** Heading text — a location path (`Garage › Shelf A`), a category name, or `''` for no grouping. */
  readonly groupLabel: string;
  /** Depth in the location tree (0 = root); 0 for category/none. Drives the print indentation. */
  readonly depth: number;
  readonly lines: readonly CatalogueLine[];
  /** Sum of the section's line values (priced lines only). */
  readonly subtotal: number;
  /** Sum of the section's on-hand quantities. */
  readonly totalQuantity: number;
}

/** The whole catalogue: ordered sections, a grand total and headline counts. */
export interface PartsCatalogue {
  readonly groups: readonly CatalogueGroup[];
  /** Total line value across every section (priced lines only). */
  readonly grandTotal: number;
  /** Total on-hand quantity across every section. */
  readonly totalQuantity: number;
  /** Total number of lines (items) on the catalogue. */
  readonly itemCount: number;
  /** True when at least one line is priced — the screen shows totals only then. */
  readonly hasValue: boolean;
  /** When the document was generated (UNIX-ms); printed as the "as of" date. */
  readonly generatedAt: number;
}

/**
 * An item is priced when a figure exists to value it by — a manual unit cost, a preferred
 * supplier cost or a depreciated purchase price (issue #688), or for a gauge its cost per unit of
 * measure (issue #683). A gauge is never priced from the first three: they price one *countable*
 * unit, and it holds a measure.
 *
 * This must name exactly the sources `valuedUnitValue` values from. Leaving one out prints a
 * dash on a line the valuation reports total a real figure for, and the catalogue's own grand
 * total would then disagree with the value column above it.
 */
function isPriced(item: CatalogueItemInput): boolean {
  if (item.gauge) return item.gauge.costPerUnitOfMeasure != null;
  return item.unitCost != null || item.preferredSupplierCost != null || item.depreciatedPurchasePrice != null;
}

/** Resolve a single item input to its display line, valuing it through the cost seam. */
function toLine(item: CatalogueItemInput, now: number): CatalogueLine {
  // A gauge's count is always 0, so its line is quantified and valued by its contents — the
  // same `valuedAmount` seam the valuation reports and the schedule use (issue #683).
  const qty = valuedAmount(item);
  // Only priced items get a cost/line value; an unpriced item reads "—" rather than £0 so the
  // catalogue never implies a real zero price. The value seams return 0 when unpriced, so gate
  // on `isPriced` first.
  const unitCost = isPriced(item) ? valuedUnitValue(item) : null;
  const lineValue = unitCost != null ? qty * unitCost : null;
  return {
    id: item.id,
    name: item.name,
    locationId: item.locationId,
    category: item.category,
    description: item.description,
    thumbnail: item.thumbnail,
    quantity: qty,
    unitOfMeasure: item.unitOfMeasure,
    measured: item.gauge != null,
    condition: item.condition,
    serialNo: item.serialNo,
    mpn: item.mpn,
    manufacturer: item.manufacturer,
    supplier: item.supplier,
    unitCost,
    lineValue,
    purchasePrice: item.purchasePrice,
    acquiredAt: item.acquiredAt,
    // Only `warrantyExpiresAt` (+ acquisition) drives the status; depreciation is never applied.
    warranty: warrantyStatus(
      {
        acquiredAt: item.acquiredAt,
        warrantyExpiresAt: item.warrantyExpiresAt,
        purchasePrice: item.purchasePrice,
        depreciationMonths: null,
      },
      now,
    ),
    notes: item.notes,
  };
}

/** Options controlling how the catalogue is grouped and ordered. */
export interface BuildCatalogueOptions {
  /** How sections are grouped (default `location`). */
  readonly groupBy?: CatalogueGroupBy;
  /** How lines are ordered within a section (default `name`). */
  readonly sortBy?: CatalogueSortBy;
}

/** Repository-level options: the {@link BuildCatalogueOptions} plus whether to fetch thumbnails. */
export interface CataloguePartsOptions extends BuildCatalogueOptions {
  /** Fetch each item's thumbnail BLOB — only needed when the Photo column is on. */
  readonly includePhotos?: boolean;
}

/** Line comparator for the chosen sort — falls back to name (then id) for a stable order. */
function lineComparator(sortBy: CatalogueSortBy): (a: CatalogueLine, b: CatalogueLine) => number {
  const byName = (a: CatalogueLine, b: CatalogueLine) =>
    a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }) || a.id.localeCompare(b.id);
  if (sortBy === 'value') return (a, b) => (b.lineValue ?? 0) - (a.lineValue ?? 0) || byName(a, b);
  if (sortBy === 'quantity') return (a, b) => b.quantity - a.quantity || byName(a, b);
  return byName;
}

/** Build one resolved section from its lines, applying the sort and rolling up its totals. */
function makeGroup(
  groupId: string | null,
  groupLabel: string,
  depth: number,
  lines: CatalogueLine[],
  compare: (a: CatalogueLine, b: CatalogueLine) => number,
): CatalogueGroup {
  const sorted = [...lines].sort(compare);
  const subtotal = sorted.reduce((sum, l) => sum + (l.lineValue ?? 0), 0);
  // Measured lines are deliberately excluded: a group's "in stock" figure is a count of units,
  // and a gauge holds grams or millilitres (issue #683).
  const totalQuantity = sorted.reduce((sum, l) => sum + (l.measured ? 0 : Math.max(0, l.quantity)), 0);
  return { groupId, groupLabel, depth, lines: sorted, subtotal, totalQuantity };
}

/**
 * Build the parts catalogue: resolve each item to a line, group the lines by the chosen key
 * (`location` — its home location, ordered by the hierarchy; `category` — its category name,
 * alphabetical; or `none` — a single section), sort lines within each section, and roll up a
 * per-section value subtotal + total quantity and the overall totals.
 *
 * For `location`, items whose location cannot be resolved fall into a trailing "Unassigned"
 * section; for `category`, uncategorised items fall into a trailing "Uncategorised" section.
 * Only sections that hold at least one item are emitted. `now` is injected (for the warranty
 * derivation and the `generatedAt` stamp) so the result is deterministic.
 */
export function buildPartsCatalogue(
  items: readonly CatalogueItemInput[],
  locations: readonly CatalogueLocationInput[],
  now: number,
  options: BuildCatalogueOptions = {},
): PartsCatalogue {
  const groupBy = options.groupBy ?? DEFAULT_CATALOGUE_GROUP_BY;
  const compare = lineComparator(options.sortBy ?? DEFAULT_CATALOGUE_SORT_BY);
  const lines = items.map((item) => toLine(item, now));

  let groups: CatalogueGroup[];
  if (groupBy === 'none') {
    // A single unheaded section holding every line.
    groups = lines.length > 0 ? [makeGroup(null, '', 0, lines, compare)] : [];
  } else if (groupBy === 'category') {
    groups = groupByCategory(lines, compare);
  } else {
    groups = groupByLocation(lines, locations, compare);
  }

  const grandTotal = groups.reduce((sum, g) => sum + g.subtotal, 0);
  const totalQuantity = groups.reduce((sum, g) => sum + g.totalQuantity, 0);
  const itemCount = groups.reduce((sum, g) => sum + g.lines.length, 0);
  const hasValue = groups.some((g) => g.lines.some((l) => l.lineValue != null));
  return { groups, grandTotal, totalQuantity, itemCount, hasValue, generatedAt: now };
}

/** Group lines by home location, ordered by the location hierarchy (unresolved → trailing bucket). */
function groupByLocation(
  lines: readonly CatalogueLine[],
  locations: readonly CatalogueLocationInput[],
  compare: (a: CatalogueLine, b: CatalogueLine) => number,
): CatalogueGroup[] {
  const known = new Set(locations.map((l) => l.id));
  const byLocation = new Map<string | null, CatalogueLine[]>();
  for (const line of lines) {
    const key = line.locationId != null && known.has(line.locationId) ? line.locationId : null;
    const bucket = byLocation.get(key);
    if (bucket) bucket.push(line);
    else byLocation.set(key, [line]);
  }

  const groups: CatalogueGroup[] = [];
  for (const loc of flattenLocationHierarchy(locations)) {
    const bucket = byLocation.get(loc.id);
    if (bucket && bucket.length > 0) groups.push(makeGroup(loc.id, loc.path, loc.depth, bucket, compare));
  }
  const unassigned = byLocation.get(null);
  if (unassigned && unassigned.length > 0) {
    groups.push(makeGroup(null, UNASSIGNED_GROUP_LABEL, 0, unassigned, compare));
  }
  return groups;
}

/** Group lines by category name (alphabetical), uncategorised items in a trailing bucket. */
function groupByCategory(
  lines: readonly CatalogueLine[],
  compare: (a: CatalogueLine, b: CatalogueLine) => number,
): CatalogueGroup[] {
  const byCategory = new Map<string | null, CatalogueLine[]>();
  for (const line of lines) {
    const key = line.category && line.category.trim() ? line.category : null;
    const bucket = byCategory.get(key);
    if (bucket) bucket.push(line);
    else byCategory.set(key, [line]);
  }

  const named = [...byCategory.keys()].filter((k): k is string => k !== null);
  named.sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));

  const groups: CatalogueGroup[] = [];
  for (const name of named) {
    groups.push(makeGroup(`category:${name}`, name, 0, byCategory.get(name)!, compare));
  }
  const uncategorised = byCategory.get(null);
  if (uncategorised && uncategorised.length > 0) {
    groups.push(makeGroup(null, UNCATEGORISED_GROUP_LABEL, 0, uncategorised, compare));
  }
  return groups;
}
