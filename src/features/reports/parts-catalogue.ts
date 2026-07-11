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
 * rooms identically. Per-unit cost flows through the same {@link effectiveUnitCost} seam as
 * every other valuation (a manual cost wins, else the preferred supplier cost); an item with
 * neither is *unpriced* — its cost and line value read as "—" rather than a misleading £0.
 */
import { effectiveUnitCost, type ValuedUnit } from './reports';
import {
  flattenLocationHierarchy,
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
  | 'category'
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
  | 'notes';

/** Presentation metadata for one selectable catalogue column. */
export interface CatalogueFieldDef {
  readonly key: CatalogueFieldKey;
  /** Column header text. */
  readonly label: string;
  /** Text alignment — numeric/money columns sit right, everything else left. */
  readonly align: 'left' | 'right';
  /** True when the column shows a money value; a selected money column enables the totals. */
  readonly money?: boolean;
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
    key: 'category',
    label: 'Category',
    align: 'left',
    help: "The item's category. **Include it** to scan or group the catalogue by type; **leave it out** for a shorter, name-focused list.",
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
];

/** The columns shown before the reader customises them — a compact, costed default. */
export const DEFAULT_CATALOGUE_FIELDS: readonly CatalogueFieldKey[] = [
  'category',
  'quantity',
  'unitCost',
  'lineValue',
];

/** The set of {@link CatalogueFieldKey}s that carry a money value (drive the totals footer). */
export const CATALOGUE_MONEY_FIELDS: ReadonlySet<CatalogueFieldKey> = new Set(
  CATALOGUE_FIELDS.filter((f) => f.money).map((f) => f.key),
);

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
 * {@link ValuedUnit} so it flows through {@link effectiveUnitCost}). Only the fields the
 * document can show are carried, keeping the helper testable.
 */
export interface CatalogueItemInput extends ValuedUnit {
  readonly id: string;
  readonly name: string;
  /** The home location the item is grouped under; null/unknown → the "Unassigned" group. */
  readonly locationId: string | null;
  /** Category name, or null when uncategorised. */
  readonly category: string | null;
  /** On-hand quantity; the line value is `quantity × unit cost`. */
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
  readonly category: string | null;
  readonly quantity: number;
  readonly unitOfMeasure: string | null;
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

/** A location group with its lines and value subtotal (0 when nothing in it is priced). */
export interface CatalogueGroup {
  /** The grouping location id, or null for the trailing "Unassigned" bucket. */
  readonly locationId: string | null;
  /** Full hierarchical path, e.g. `Garage › Shelf A`; the bare name for a root location. */
  readonly locationPath: string;
  /** Depth in the location tree (0 = root); drives the print indentation. */
  readonly depth: number;
  readonly lines: readonly CatalogueLine[];
  /** Sum of the group's line values (priced lines only). */
  readonly subtotal: number;
}

/** The whole catalogue: ordered location groups, a grand total and headline counts. */
export interface PartsCatalogue {
  readonly groups: readonly CatalogueGroup[];
  /** Total line value across every group (priced lines only). */
  readonly grandTotal: number;
  /** Total number of lines (items) on the catalogue. */
  readonly itemCount: number;
  /** True when at least one line is priced — the screen shows totals only then. */
  readonly hasValue: boolean;
  /** When the document was generated (UNIX-ms); printed as the "as of" date. */
  readonly generatedAt: number;
}

/** An item is priced when it has a manual unit cost or a preferred supplier cost. */
function isPriced(item: CatalogueItemInput): boolean {
  return item.unitCost != null || item.preferredSupplierCost != null;
}

/** Resolve a single item input to its display line, valuing it through the cost seam. */
function toLine(item: CatalogueItemInput, now: number): CatalogueLine {
  const qty = Math.max(0, item.quantity);
  // Only priced items get a cost/line value; an unpriced item reads "—" rather than £0 so the
  // catalogue never implies a real zero price. `effectiveUnitCost` returns 0 when unpriced,
  // so gate on `isPriced` first.
  const unitCost = isPriced(item) ? effectiveUnitCost(item) : null;
  const lineValue = unitCost != null ? qty * unitCost : null;
  return {
    id: item.id,
    name: item.name,
    category: item.category,
    quantity: item.quantity,
    unitOfMeasure: item.unitOfMeasure,
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

/**
 * Build the parts catalogue: group every item by its home location, order the groups by the
 * location hierarchy (depth-first, siblings alphabetical — shared with the insurance schedule),
 * and roll up a per-location value subtotal and an overall grand total.
 *
 * Lines within a group are sorted by name (then id, for stability). Items whose location
 * cannot be resolved fall into a trailing "Unassigned" group. Only locations that actually
 * hold at least one item become a group. `now` is injected (for the warranty derivation and
 * the `generatedAt` stamp) so the result is deterministic.
 */
export function buildPartsCatalogue(
  items: readonly CatalogueItemInput[],
  locations: readonly CatalogueLocationInput[],
  now: number,
): PartsCatalogue {
  const linesByLocation = new Map<string | null, CatalogueLine[]>();
  const known = new Set(locations.map((l) => l.id));
  for (const item of items) {
    const key = item.locationId != null && known.has(item.locationId) ? item.locationId : null;
    const line = toLine(item, now);
    const bucket = linesByLocation.get(key);
    if (bucket) bucket.push(line);
    else linesByLocation.set(key, [line]);
  }

  const byName = (a: CatalogueLine, b: CatalogueLine) =>
    a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }) || a.id.localeCompare(b.id);

  const makeGroup = (
    locationId: string | null,
    locationPath: string,
    depth: number,
    lines: CatalogueLine[],
  ): CatalogueGroup => {
    const sorted = [...lines].sort(byName);
    const subtotal = sorted.reduce((sum, l) => sum + (l.lineValue ?? 0), 0);
    return { locationId, locationPath, depth, lines: sorted, subtotal };
  };

  const groups: CatalogueGroup[] = [];
  for (const loc of flattenLocationHierarchy(locations)) {
    const lines = linesByLocation.get(loc.id);
    if (lines && lines.length > 0) groups.push(makeGroup(loc.id, loc.path, loc.depth, lines));
  }
  // The unresolved bucket sorts last, at the root depth.
  const unassigned = linesByLocation.get(null);
  if (unassigned && unassigned.length > 0) {
    groups.push(makeGroup(null, UNASSIGNED_GROUP_LABEL, 0, unassigned));
  }

  const grandTotal = groups.reduce((sum, g) => sum + g.subtotal, 0);
  const itemCount = groups.reduce((sum, g) => sum + g.lines.length, 0);
  const hasValue = groups.some((g) => g.lines.some((l) => l.lineValue != null));
  return { groups, grandTotal, itemCount, hasValue, generatedAt: now };
}
