/**
 * Pure aggregation for the **parts catalogue** (issue #22) — a formatted, printable list of
 * items scoped by location, by project, or by an ad-hoc selection, with the reader choosing
 * which columns (cost, supplier, quantity, condition, …) appear. It doubles as an actionable
 * parts list or a plain inventory.
 *
 * Same "logic out of glue" seam as {@link ./insurance-schedule} and `reports.ts`: kept free
 * of React, repositories, SQL and the DOM so the grouping, ordering, per-line valuation and
 * totals are exhaustively unit-tested in isolation. The screen renders the returned DTOs, showing
 * only the columns the reader selected (the field selection is a *presentation* choice and does
 * not change what is resolved — every field always is).
 *
 * **The catalogue is read in two halves** (issue #410), exactly as the insurance schedule is
 * (issue #163). `ReportRepository` first sums the whole scope in SQLite into one tally per section
 * and {@link finalisePartsCatalogueSummary} turns those into the document's ordered headings and
 * totals — bounded by the section count, not the item count. It then reads one section's lines at
 * a time through {@link toCatalogueLine}. Nothing here ever holds a row per item, so "All items"
 * over a large inventory costs a few dozen numbers rather than a whole-inventory transfer, a
 * whole-inventory structured clone and a whole-inventory DOM.
 *
 * Location grouping, hierarchy ordering and the trailing "Unassigned" bucket are shared with
 * the insurance schedule via {@link flattenLocationHierarchy}, so the two documents order
 * rooms identically. Per-unit cost flows through the same {@link valuedUnitValue} seam as every
 * other valuation (a manual current value wins, else a manual cost, else the preferred supplier
 * cost, else the depreciated purchase price — or, for a gauge, its cost per unit of measure, since
 * it holds a measure rather than countable units); an item with none of those is *unpriced* — its
 * cost and line value read as a dash rather than a misleading zero.
 */
import { hasValuationSource, valuedAmount, valuedUnitValue, type ValuedStock } from './reports';
import {
  flattenLocationHierarchy,
  PRINT_FULL_LIMIT,
  PRINT_PHOTO_LIMIT,
  scheduleLineValue,
  UNASSIGNED_GROUP_LABEL,
  type ScheduleLocationInput,
} from './insurance-schedule';
import { MONEY_DECIMALS, sumMoney } from '@/lib/money';
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
 * Printing renders every line of the scope into one document, so "All items" over a large
 * inventory had nothing standing between the reader and a browser print dialog holding hundreds
 * of pages — and, with the QR column on, one synchronous QR encode per line before it could even
 * open.
 *
 * The ceiling now bounds **printing alone**. Reading the catalogue on screen is paged (issue
 * #410), so a scope of any size can be browsed a page at a time; what a ceiling still has to
 * stand in front of is the one artefact whose size is the whole document.
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
  /**
   * The per-unit value `valuedUnitValue` resolved — a manual current value (issue #706), else a
   * manual unit cost, else the preferred supplier price, else the depreciated purchase price
   * (issue #688); for a gauge, its cost per unit of measure. Null when {@link isPriced} finds no
   * source at all, which is what prints a dash instead of `0.00`.
   */
  readonly unitCost: number | null;
  /** `quantity × unitCost`, or null when the item is unpriced. */
  readonly lineValue: number | null;
  readonly purchasePrice: number | null;
  readonly acquiredAt: string | null;
  readonly warranty: WarrantyStatus;
  readonly notes: string | null;
}

/**
 * How one group's lines are **addressed** when the repository reads a bounded page of them
 * (issue #410).
 *
 * The catalogue's group *ordering* is resolved in TypeScript — the location hierarchy, or
 * category names compared the way the reader sees them — so a page read has to be told which
 * rows a group covers rather than reproducing that ordering in SQL. Each variant names a
 * predicate the repository can bind directly, and every one of them is derived from the summary
 * read that produced the group, so a page can never describe a different set from its heading.
 *
 *  - `all` — the whole scope, for the single unheaded "No grouping" section.
 *  - `location` / `unassigned` — a room, or the trailing bucket of items whose location is unset
 *    **or** points at a deleted location (the half that is easy to lose; see
 *    {@link ./insurance-schedule}'s `resolveScheduleGroupKey`).
 *  - `category` — every category id folded into this heading. Category names carry no uniqueness
 *    constraint, so two categories sharing a name are one section on the page and must be one
 *    predicate here too.
 *  - `uncategorised` — items with no category, items pointing at a deleted one, and items in a
 *    category whose name is blank (`blankCategoryIds`), which reads as no heading at all.
 */
export type CatalogueGroupRef =
  | { readonly kind: 'all' }
  | { readonly kind: 'location'; readonly locationId: string }
  | { readonly kind: 'unassigned' }
  | { readonly kind: 'category'; readonly categoryIds: readonly string[] }
  | { readonly kind: 'uncategorised'; readonly blankCategoryIds: readonly string[] };

/**
 * One raw grouped tally, exactly as the repository's summary read returns it — one row per
 * location or per category, never one per item.
 *
 * Holding these rather than the lines is what lets a whole-inventory catalogue be totalled
 * without materialising a row per item (issue #410, the shape issue #163 gave the insurance
 * schedule): memory and transfer are O(groups), not O(items).
 */
export interface CatalogueGroupTally {
  /** The grouping row's id — a location id, a category id, or null when it did not resolve. */
  readonly groupId: string | null;
  /** The grouping row's name (categories only); null when the row did not resolve. */
  readonly groupName: string | null;
  readonly itemCount: number;
  /**
   * The group's value as an exact integer count of the reporting currency's **minor units**.
   *
   * Integer addition is exact and associative, so a subtotal cannot depend on the order rows
   * happened to be scanned in — the same reason the schedule's tally counts minor units
   * (issue #163). Each line is quantised before it is summed, so the column of figures the
   * document prints adds up to the subtotal beneath it (issue #288).
   */
  readonly subtotalMinorUnits: number;
  /** Sum of the on-hand **counts**; a gauge holds a measure, not units, and contributes 0. */
  readonly totalQuantity: number;
  /** How many of the group's lines any source prices at all — 0 means every line reads a dash. */
  readonly pricedCount: number;
}

/** A catalogue section's headline figures and page address, without its lines. */
export interface CatalogueGroupSummary {
  /** Stable id of the section (location id, or `category:<name>`), or null for a trailing bucket. */
  readonly groupId: string | null;
  /** Heading text — a location path (`Garage › Shelf A`), a category name, or `''` for no grouping. */
  readonly groupLabel: string;
  /** Depth in the location tree (0 = root); 0 for category/none. Drives the print indentation. */
  readonly depth: number;
  /** How many lines the section holds in total — **not** how many are on the current page. */
  readonly itemCount: number;
  /** Sum of the section's line values (priced lines only). */
  readonly subtotal: number;
  /** Sum of the section's on-hand quantities. */
  readonly totalQuantity: number;
  /** How the repository reads a bounded page of this section's lines. */
  readonly ref: CatalogueGroupRef;
}

/** The catalogue's totals and section ordering, with no lines: bounded by the group count. */
export interface PartsCatalogueSummary {
  readonly groups: readonly CatalogueGroupSummary[];
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
 * An item is priced when a figure exists to value it by. The list of sources is **not** restated
 * here: {@link hasValuationSource} owns it beside `valuedUnitValue`, so a source added to the
 * valuation precedence cannot be missed by the catalogue. That is exactly how the manual
 * `current_value` came to be omitted here (issue #706) — a line was printed as unpriced while the
 * valuation reports and the insurance schedule priced the same item at its revalued worth.
 *
 * The distinction still matters at this call site: the value seams answer `0` both for "worth
 * nothing" and for "nothing prices it", and the document must print a dash for the second rather
 * than a real-looking zero.
 */
function isPriced(item: CatalogueItemInput): boolean {
  return hasValuationSource(item);
}

/**
 * Resolve one item to its catalogue line, valuing it through the shared cost seam.
 *
 * Exported because the catalogue is read a **page at a time** (issue #410): `ReportRepository`
 * resolves each page's rows through here, so there is exactly one place that decides what a line
 * says and what it is worth.
 *
 * The line value is {@link scheduleLineValue} — the insurance schedule's line, quantised to the
 * reporting currency's minor unit — gated on {@link isPriced}. Sharing it is what makes the
 * subtotal beneath a printed column the sum of the figures in it (issue #288), and what keeps a
 * catalogue line and the same item's schedule line from ever disagreeing about the same asset.
 *
 * `decimals` is the reporting currency's minor unit, not a flat 2dp (issue #292).
 */
export function toCatalogueLine(item: CatalogueItemInput, now: number, decimals: number): CatalogueLine {
  // A gauge's count is always 0, so its line is quantified and valued by its contents — the
  // same `valuedAmount` seam the valuation reports and the schedule use (issue #683).
  const qty = valuedAmount(item);
  // Only priced items get a cost/line value; an unpriced item reads a dash rather than a zero, so
  // the catalogue never implies a real zero price. The value seams return 0 when unpriced, so
  // gate on `isPriced` first.
  const priced = isPriced(item);
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
    unitCost: priced ? valuedUnitValue(item) : null,
    lineValue: priced ? scheduleLineValue(item, decimals) : null,
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

/** A running merge of the tallies that fold into one printed section. */
interface SectionAccumulator {
  itemCount: number;
  minorUnits: number;
  totalQuantity: number;
  /** Category ids folded into this section (empty for a location or the ungrouped section). */
  readonly categoryIds: string[];
}

/** Fold one tally into the section keyed by `key`, creating the section on first sight. */
function foldTally(
  sections: Map<string | null, SectionAccumulator>,
  key: string | null,
  tally: CatalogueGroupTally,
): SectionAccumulator {
  let entry = sections.get(key);
  if (entry === undefined) {
    entry = { itemCount: 0, minorUnits: 0, totalQuantity: 0, categoryIds: [] };
    sections.set(key, entry);
  }
  entry.itemCount += tally.itemCount;
  entry.minorUnits += tally.subtotalMinorUnits;
  entry.totalQuantity += tally.totalQuantity;
  return entry;
}

/**
 * Resolve one merged section to its summary.
 *
 * The subtotal is the integer minor-unit tally divided back to major units. Above roughly 90
 * trillion at 2dp that count leaves JavaScript's exact-integer range and the figure degrades to
 * the nearest representable double — a total no real inventory reaches, and the same documented
 * ceiling the insurance schedule's tally carries.
 */
function toSectionSummary(
  groupId: string | null,
  groupLabel: string,
  depth: number,
  entry: SectionAccumulator,
  ref: CatalogueGroupRef,
  decimals: number,
): CatalogueGroupSummary {
  return {
    groupId,
    groupLabel,
    depth,
    itemCount: entry.itemCount,
    subtotal: entry.minorUnits / 10 ** decimals,
    totalQuantity: entry.totalQuantity,
    ref,
  };
}

/** Sections grouped by home location, ordered by the hierarchy (unresolved into a trailing bucket). */
function locationSections(
  tallies: readonly CatalogueGroupTally[],
  locations: readonly CatalogueLocationInput[],
  decimals: number,
): CatalogueGroupSummary[] {
  const known = new Set(locations.map((l) => l.id));
  const sections = new Map<string | null, SectionAccumulator>();
  for (const tally of tallies) {
    // A location that no longer exists folds into "Unassigned" rather than vanishing — the same
    // rule `resolveScheduleGroupKey` states for the schedule.
    foldTally(sections, tally.groupId != null && known.has(tally.groupId) ? tally.groupId : null, tally);
  }

  const groups: CatalogueGroupSummary[] = [];
  for (const loc of flattenLocationHierarchy(locations)) {
    const entry = sections.get(loc.id);
    if (entry === undefined || entry.itemCount === 0) continue;
    groups.push(
      toSectionSummary(
        loc.id,
        loc.path,
        loc.depth,
        entry,
        { kind: 'location', locationId: loc.id },
        decimals,
      ),
    );
  }
  const unassigned = sections.get(null);
  if (unassigned !== undefined && unassigned.itemCount > 0) {
    groups.push(
      toSectionSummary(null, UNASSIGNED_GROUP_LABEL, 0, unassigned, { kind: 'unassigned' }, decimals),
    );
  }
  return groups;
}

/** Sections grouped by category name (alphabetical), uncategorised items in a trailing bucket. */
function categorySections(
  tallies: readonly CatalogueGroupTally[],
  decimals: number,
): CatalogueGroupSummary[] {
  const sections = new Map<string | null, SectionAccumulator>();
  for (const tally of tallies) {
    // Grouped by the *name* the heading shows, so two categories that read the same are one
    // section; a blank or absent name is no heading at all and joins the trailing bucket.
    const key = tally.groupName && tally.groupName.trim() ? tally.groupName : null;
    const entry = foldTally(sections, key, tally);
    if (tally.groupId != null) entry.categoryIds.push(tally.groupId);
  }

  const named = [...sections.keys()].filter((k): k is string => k !== null);
  named.sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));

  const groups: CatalogueGroupSummary[] = [];
  for (const name of named) {
    const entry = sections.get(name)!;
    if (entry.itemCount === 0) continue;
    groups.push(
      toSectionSummary(
        `category:${name}`,
        name,
        0,
        entry,
        { kind: 'category', categoryIds: entry.categoryIds },
        decimals,
      ),
    );
  }
  const uncategorised = sections.get(null);
  if (uncategorised !== undefined && uncategorised.itemCount > 0) {
    groups.push(
      toSectionSummary(
        null,
        UNCATEGORISED_GROUP_LABEL,
        0,
        uncategorised,
        // Only the ids of *existing* categories whose name is blank need naming: an unset or
        // dangling `category_id` is matched by the predicate itself.
        { kind: 'uncategorised', blankCategoryIds: uncategorised.categoryIds },
        decimals,
      ),
    );
  }
  return groups;
}

/**
 * Resolve the repository's grouped tallies into the catalogue's ordered sections and totals.
 *
 * This is the catalogue's whole shape with none of its lines (issue #410): section order,
 * headings, per-section counts and subtotals, and the grand totals beneath them. The screen
 * reads it first — it is what page navigation and the printed summary are built from — and then
 * asks for one bounded page of lines at a time.
 *
 * Sections are ordered exactly as the printed document orders them: by the location hierarchy
 * (unresolved rooms last), by category name (uncategorised last), or a single unheaded section
 * for "No grouping". Empty sections are omitted. `now` is injected for the `generatedAt` stamp
 * so the result is deterministic.
 *
 * @param options.decimals Places every rung of the document is quantised to — the reporting
 * currency's **minor unit**, not a flat 2dp (issue #292). Each line is already quantised to it by
 * {@link toCatalogueLine}, so the subtotals here sum the figures the document actually prints and
 * the grand total sums those subtotals (issue #288).
 */
export function finalisePartsCatalogueSummary(
  tallies: readonly CatalogueGroupTally[],
  locations: readonly CatalogueLocationInput[],
  now: number,
  options: { readonly groupBy?: CatalogueGroupBy; readonly decimals?: number } = {},
): PartsCatalogueSummary {
  const groupBy = options.groupBy ?? DEFAULT_CATALOGUE_GROUP_BY;
  const decimals = options.decimals ?? MONEY_DECIMALS;

  let groups: CatalogueGroupSummary[];
  if (groupBy === 'none') {
    const sections = new Map<string | null, SectionAccumulator>();
    for (const tally of tallies) foldTally(sections, null, tally);
    const only = sections.get(null);
    groups =
      only !== undefined && only.itemCount > 0
        ? [toSectionSummary(null, '', 0, only, { kind: 'all' }, decimals)]
        : [];
  } else if (groupBy === 'category') {
    groups = categorySections(tallies, decimals);
  } else {
    groups = locationSections(tallies, locations, decimals);
  }

  return {
    groups,
    grandTotal: sumMoney(
      groups.map((g) => g.subtotal),
      decimals,
    ),
    totalQuantity: groups.reduce((sum, g) => sum + g.totalQuantity, 0),
    itemCount: groups.reduce((sum, g) => sum + g.itemCount, 0),
    hasValue: tallies.some((t) => t.pricedCount > 0),
    generatedAt: now,
  };
}
