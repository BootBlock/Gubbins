/**
 * Pure aggregation for the insurance / estate schedule (feature-gap G1) — a formatted,
 * printable room-by-room document of every catalogued asset with its replacement value,
 * suitable for an insurer, estate or claim.
 *
 * Kept free of React, repositories, SQL and the DOM (same "logic out of glue" seam as
 * `reports.ts`, `asset-lifecycle.ts`, `reorder-policy.ts`) so the grouping, subtotals,
 * grand total, hierarchy ordering and per-line valuation are exhaustively unit-tested in
 * isolation. `ReportRepository` pulls the minimal raw rows from SQLite and hands them here;
 * the screen renders the resulting DTO with `useFormatters` / `<Money>`.
 *
 * Valuation flows through the single {@link stockValue} seam shared with the valuation reports,
 * so a document handed to an insurer and the totals on screen can never disagree: a manual
 * {@link ScheduleItemInput.currentValuePerUnit} wins over the replacement cost (G9, so an
 * appreciating asset is scheduled at today's worth), else the manual cost, else the preferred
 * supplier cost, else the depreciated purchase price (issue #688, so an old tool priced only by
 * what it cost years ago is scheduled at its book value rather than left at nothing), else 0.
 * A CONSUMABLE_GAUGE asset is valued from its contents and its cost per
 * unit of measure instead (issue #683) — it holds a measure rather than units, so the counted
 * product would schedule a full cylinder at zero however carefully it was priced.
 *
 * **The figures add up as printed** (issue #288). A schedule is a document someone checks with a
 * calculator, so each rung is quantised through `@/lib/money` and sums the rung below it in its
 * rounded form: line → location subtotal → grand total.
 */
import { stockValue, type ValuedStock } from './reports';
import { sliceGroupsForPage } from './group-slices';
import { MONEY_DECIMALS, roundMoney, sumMoney } from '@/lib/money';
import { warrantyStatus, type WarrantyStatus } from '@/features/inventory/asset-lifecycle';
import type { Condition } from '@/db/repositories/constants';

/** A raw location row (id + name + parent) used to order the schedule by hierarchy. */
export interface ScheduleLocationInput {
  readonly id: string;
  readonly name: string;
  readonly parentId: string | null;
}

/**
 * One catalogued asset to place on the schedule — a minimal, structural slice of `Item`
 * (extends {@link ValuedStock} so it flows through the shared {@link stockValue} rule). Only the
 * fields the document actually shows or values are carried, keeping the helper testable.
 */
export interface ScheduleItemInput extends ValuedStock {
  readonly id: string;
  readonly name: string;
  /** SERIALISED instance number (1..N), or null for a non-serialised item. */
  readonly serialNo: number | null;
  /** Operational condition (Mint/Good/…), or null when untracked. */
  readonly condition: Condition | null;
  /**
   * On-hand quantity; the line value is `quantity × per-unit value`. A CONSUMABLE_GAUGE asset
   * carries 0 here and is valued from {@link ScheduleItemInput.gauge} instead (issue #683).
   */
  readonly quantity: number;
  /**
   * The unit of measure a gauge's contents are held in (`g`, `m³`), for the line's amount
   * caption; null for every other tracking mode, which counts units instead (issue #683).
   */
  readonly unitOfMeasure?: string | null;
  /** ISO date (`YYYY-MM-DD`) the asset was acquired, or null when untracked. */
  readonly acquiredAt: string | null;
  /** ISO date the warranty expires, or null; drives the derived warranty status. */
  readonly warrantyExpiresAt: string | null;
  /** Original acquisition cost per unit, or null when unpriced. */
  readonly purchasePrice: number | null;
  /** The home location the asset is grouped under; null/unknown → the "Unassigned" group. */
  readonly locationId: string | null;
  /**
   * Optional manual current / market value **per unit** (G9 forward-hook). When non-null it
   * wins over the effective replacement cost so an appreciating asset is scheduled at today's
   * worth rather than its depreciated replacement cost.
   */
  readonly currentValuePerUnit?: number | null;
  /** Primary thumbnail bytes (opaque passthrough to the UI); null when the item has no photo. */
  readonly thumbnail?: Uint8Array | null;
}

/** A resolved schedule line: the display fields plus the derived warranty + line value. */
export interface ScheduleLine {
  readonly id: string;
  readonly name: string;
  readonly serialNo: number | null;
  readonly condition: Condition | null;
  readonly quantity: number;
  /**
   * For a gauge asset (issue #683): how much material it holds and in what unit, so the line
   * can print "6 m³" where a counted asset prints "Qty 3". Null for every other tracking mode.
   *
   * A gauge's {@link ScheduleLine.quantity} is 0 — it holds a measure, not units — so without
   * this the document would caption a full argon cylinder "Qty 0" beside a real value.
   */
  readonly measure: { readonly amount: number; readonly unit: string } | null;
  readonly acquiredAt: string | null;
  readonly purchasePrice: number | null;
  readonly warranty: WarrantyStatus;
  /** The asset's on-hand value (manual current value if set, else effective replacement cost). */
  readonly replacementValue: number;
  readonly thumbnail: Uint8Array | null;
}

/** A location group (room) with its lines and subtotal. */
export interface ScheduleLocationGroup {
  /** The grouping location id, or null for the trailing "Unassigned" bucket. */
  readonly locationId: string | null;
  /** Full hierarchical path, e.g. `Garage › Shelf A`; the bare name for a root location. */
  readonly locationPath: string;
  /** Depth in the location tree (0 = root); drives the print indentation. */
  readonly depth: number;
  readonly lines: readonly ScheduleLine[];
  /** Sum of the group's line replacement values. */
  readonly subtotal: number;
}

/** The whole schedule: ordered room groups, a grand total and headline counts. */
export interface InsuranceSchedule {
  readonly groups: readonly ScheduleLocationGroup[];
  /** Total replacement value across every group. */
  readonly grandTotal: number;
  /** Total number of lines (assets) on the schedule. */
  readonly itemCount: number;
  /** When the document was generated (UNIX-ms); printed as the "as of" date. */
  readonly generatedAt: number;
}

/** Heading for the bucket holding items whose location cannot be resolved. */
export const UNASSIGNED_GROUP_LABEL = 'Unassigned';

/**
 * Most assets that can be rendered into a single printable document (text only).
 *
 * Printing is bounded by what the DOM and the printer can take, not by what the database can
 * read: 20,000 lines is already 400–600 printed pages. Beyond this the schedule is offered as a
 * file instead, which an insurer or executor can search and re-total — and print any part of.
 */
export const PRINT_FULL_LIMIT = 20_000;

/**
 * The same ceiling with photos on, where image decode rather than row count is what binds:
 * 2,000 thumbnails is already several megabytes of BLOBs and 2,000 `<img>` decodes before the
 * print dialog can open.
 */
export const PRINT_PHOTO_LIMIT = 2_000;

/** Separator between ancestor names in a location's full path (a thin angle). */
const PATH_SEPARATOR = ' › ';

/** A location flattened to depth-first display order, with its full path and depth. */
interface OrderedLocation {
  readonly id: string;
  readonly path: string;
  readonly depth: number;
}

/**
 * Flatten a set of locations into depth-first display order, resolving each to its full
 * ancestor path and tree depth. Siblings are ordered case-insensitively by name; a node
 * whose `parentId` does not resolve to a known location is treated as a root (so an
 * orphaned branch still appears). A defensive `visited` guard means a malformed parent
 * cycle can never loop forever — a node is emitted at most once.
 */
export function flattenLocationHierarchy(locations: readonly ScheduleLocationInput[]): OrderedLocation[] {
  const byId = new Map(locations.map((l) => [l.id, l]));
  const childrenOf = new Map<string | null, ScheduleLocationInput[]>();
  for (const loc of locations) {
    // Treat an unresolved parent as a root so the branch is never dropped.
    const parentKey = loc.parentId != null && byId.has(loc.parentId) ? loc.parentId : null;
    const bucket = childrenOf.get(parentKey);
    if (bucket) bucket.push(loc);
    else childrenOf.set(parentKey, [loc]);
  }

  const byName = (a: ScheduleLocationInput, b: ScheduleLocationInput) =>
    a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }) || a.id.localeCompare(b.id);

  const ordered: OrderedLocation[] = [];
  const visited = new Set<string>();
  const walk = (parentKey: string | null, parentPath: string, depth: number) => {
    const children = [...(childrenOf.get(parentKey) ?? [])].sort(byName);
    for (const child of children) {
      if (visited.has(child.id)) continue; // defensive: never revisit (cycle-safe)
      visited.add(child.id);
      const path = parentPath ? parentPath + PATH_SEPARATOR + child.name : child.name;
      ordered.push({ id: child.id, path, depth });
      walk(child.id, path, depth + 1);
    }
  };
  walk(null, '', 0);

  // Sweep up any node unreachable from a real root (only possible under a malformed parent
  // cycle, which the repository guards against) as its own root, so no location — and thus
  // no item grouped under it — is ever silently dropped from the schedule.
  for (const loc of [...locations].sort(byName)) {
    if (visited.has(loc.id)) continue;
    visited.add(loc.id);
    ordered.push({ id: loc.id, path: loc.name, depth: 0 });
    walk(loc.id, loc.name, 1);
  }
  return ordered;
}

/** The fields a line's value depends on — everything else on a line is presentation. */
export type ScheduleValuationInput = ValuedStock;

/**
 * The replacement value of one asset: `amount × per-unit value`, quantised to the currency's
 * minor unit (issue #292) — the line is the bottom rung of a column an insurer adds up by hand,
 * so it must be a figure that currency can actually be written in, not a flat 2dp.
 *
 * Split out from {@link toScheduleLine} because totalling a 100k-asset schedule needs the value
 * and nothing else (issue #163): resolving a full display line per row would derive a warranty
 * status a total never reads. One expression, two callers, no chance of the totals and the
 * printed lines diverging.
 *
 * Which amount, and which per-unit value, is the shared {@link stockValue} seam's decision — a
 * gauge's contents against its cost per unit of measure, else the count against the manual
 * current value or the effective replacement cost (issue #683). Before that seam existed a gauge
 * scheduled at £0 with nothing on the document to say so, which is the one error a schedule must
 * not make: a reader cannot tell an asset worth nothing from one that was silently omitted.
 */
export function scheduleLineValue(item: ScheduleValuationInput, decimals: number): number {
  return roundMoney(stockValue(item), decimals);
}

/**
 * Resolve a single asset input to its display line, valuing it through {@link scheduleLineValue}.
 *
 * Exported because the schedule is read **two** ways (issue #163): {@link buildInsuranceSchedule}
 * resolves a whole in-memory document, while `ReportRepository` resolves one bounded page at a
 * time. Both must value a line identically, so there is exactly one place that does it.
 */
export function toScheduleLine(item: ScheduleItemInput, now: number, decimals: number): ScheduleLine {
  return {
    id: item.id,
    name: item.name,
    serialNo: item.serialNo,
    condition: item.condition,
    quantity: item.quantity,
    // A gauge captions its contents rather than a unit count (issue #683); the unit is required
    // for the caption to mean anything, so a gauge missing one falls back to the count.
    measure:
      item.gauge && item.unitOfMeasure
        ? { amount: Math.max(0, item.gauge.netValue), unit: item.unitOfMeasure }
        : null,
    acquiredAt: item.acquiredAt,
    purchasePrice: item.purchasePrice,
    // Only `warrantyExpiresAt` drives the status, so the rest of the slice is filled in with
    // whatever satisfies the type. `depreciationMonths` is deliberately null rather than the
    // item's own term: this call derives a *warranty badge*, and the depreciated figure the
    // schedule values a line at is applied by `stockValue` from the item's already-resolved
    // `depreciatedPurchasePrice` (issue #688), not re-derived here.
    warranty: warrantyStatus(
      {
        acquiredAt: item.acquiredAt,
        warrantyExpiresAt: item.warrantyExpiresAt,
        purchasePrice: item.purchasePrice,
        depreciationMonths: null,
      },
      now,
    ),
    replacementValue: scheduleLineValue(item, decimals),
    thumbnail: item.thumbnail ?? null,
  };
}

/**
 * Which group an asset belongs to: its location id, or `null` for the trailing "Unassigned"
 * bucket when the location is unset **or** does not resolve to a known location.
 *
 * The "does not resolve" half matters and is easy to lose: an item pointing at a deleted
 * location must still appear on the schedule. Exported so the paged repository read can
 * reproduce this rule exactly rather than approximating it as `location_id IS NULL`.
 */
export function resolveScheduleGroupKey(
  locationId: string | null,
  knownLocationIds: ReadonlySet<string>,
): string | null {
  return locationId != null && knownLocationIds.has(locationId) ? locationId : null;
}

/** Per-group running totals; `minorUnits` is exact, `floatSum` is the overflow fallback. */
interface GroupTotal {
  count: number;
  minorUnits: number;
  floatSum: number;
}

/**
 * A running per-location tally of line count and replacement value.
 *
 * Holding this rather than the lines themselves is what lets a 100k-asset schedule be totalled
 * without ever materialising 100k rows (issue #163): memory is O(locations), not O(items).
 */
export interface ScheduleTotals {
  readonly byLocation: Map<string | null, GroupTotal>;
  /** Cleared when a running tally leaves exact-integer range; see {@link finaliseScheduleSummary}. */
  exact: boolean;
}

/** A location group's headline figures, without its lines. */
export interface ScheduleGroupSummary {
  readonly locationId: string | null;
  readonly locationPath: string;
  readonly depth: number;
  /** How many assets the group holds in total — **not** how many are on the current page. */
  readonly itemCount: number;
  readonly subtotal: number;
}

/** The schedule's totals and group ordering, with no lines: bounded by the location count. */
export interface InsuranceScheduleSummary {
  readonly groups: readonly ScheduleGroupSummary[];
  readonly grandTotal: number;
  readonly itemCount: number;
  readonly generatedAt: number;
}

/** Start an empty tally. */
export function createScheduleTotals(): ScheduleTotals {
  return { byLocation: new Map(), exact: true };
}

/**
 * Fold one already-valued line into the tally.
 *
 * The value is accumulated as an **integer count of minor units** rather than a running float.
 * Integer addition is exact and associative, so the subtotal a streamed read produces cannot
 * depend on the order rows happened to arrive in — which matters because SQLite's
 * `COLLATE NOCASE` ordering does not match the builder's `localeCompare`. A float running sum
 * would make the two reads disagree in the last minor unit for some inputs; integers make the
 * question impossible to ask.
 *
 * `floatSum` is carried alongside purely as the overflow fallback (see
 * {@link finaliseScheduleSummary}); it costs one addition and bounds nothing.
 */
export function accumulateScheduleLine(
  totals: ScheduleTotals,
  groupKey: string | null,
  replacementValue: number,
  decimals: number,
): void {
  let entry = totals.byLocation.get(groupKey);
  if (entry === undefined) {
    entry = { count: 0, minorUnits: 0, floatSum: 0 };
    totals.byLocation.set(groupKey, entry);
  }
  entry.count += 1;
  // A non-finite line value would poison the whole total; `toScheduleLine` cannot produce one,
  // but skipping matches `sumMoney`'s contract rather than turning a report into NaN.
  if (!Number.isFinite(replacementValue)) return;
  entry.floatSum += replacementValue;
  const minor = entry.minorUnits + Math.round(replacementValue * 10 ** decimals);
  if (Number.isSafeInteger(minor)) entry.minorUnits = minor;
  else totals.exact = false;
}

/**
 * Resolve the tally into ordered groups with subtotals and a grand total.
 *
 * Groups are ordered by the location hierarchy exactly as {@link buildInsuranceSchedule} orders
 * them, empty rooms are omitted, and the unresolved bucket sorts last at root depth.
 *
 * Above roughly 90 trillion at 2dp the integer tally would leave exact-integer range, so it falls
 * back to summing the floats and rounding once — the pre-#163 behaviour. That is a total no real
 * inventory reaches; the branch exists so the failure is a documented degradation rather than a
 * silently wrong figure.
 */
export function finaliseScheduleSummary(
  totals: ScheduleTotals,
  locations: readonly ScheduleLocationInput[],
  now: number,
  decimals: number = MONEY_DECIMALS,
): InsuranceScheduleSummary {
  const subtotalOf = (entry: GroupTotal): number =>
    totals.exact ? entry.minorUnits / 10 ** decimals : roundMoney(entry.floatSum, decimals);

  const groups: ScheduleGroupSummary[] = [];
  const push = (locationId: string | null, locationPath: string, depth: number) => {
    const entry = totals.byLocation.get(locationId);
    if (entry === undefined || entry.count === 0) return;
    groups.push({ locationId, locationPath, depth, itemCount: entry.count, subtotal: subtotalOf(entry) });
  };

  for (const loc of flattenLocationHierarchy(locations)) push(loc.id, loc.path, loc.depth);
  push(null, UNASSIGNED_GROUP_LABEL, 0);

  const grandTotal = sumMoney(
    groups.map((g) => g.subtotal),
    decimals,
  );
  const itemCount = groups.reduce((sum, g) => sum + g.itemCount, 0);
  return { groups, grandTotal, itemCount, generatedAt: now };
}

/** A contiguous run of one group's lines, addressed by the group's own offset. */
export interface ScheduleSlice {
  readonly locationId: string | null;
  /** Offset **within the group**, not within the document. */
  readonly offset: number;
  readonly limit: number;
}

/**
 * Map a document-wide `offset`/`limit` onto the per-group slices that cover it.
 *
 * This is where the schedule's global ordering lives. Groups are ordered by the location
 * hierarchy — a JS concern over a bounded set of locations — so a page is expressed as a handful
 * of single-location reads rather than an ordering SQLite would have to reproduce. A page
 * straddling a room boundary simply yields two slices.
 *
 * The slicing arithmetic itself is {@link sliceGroupsForPage}, shared verbatim with the parts
 * catalogue (issue #410); this only names the location each slice reads from.
 */
export function scheduleSlices(
  groups: readonly ScheduleGroupSummary[],
  offset: number,
  limit: number,
): ScheduleSlice[] {
  return sliceGroupsForPage(groups, offset, limit).map((slice) => ({
    locationId: slice.group.locationId,
    offset: slice.offset,
    limit: slice.limit,
  }));
}

/**
 * Build the insurance / estate schedule: group every asset by its home location, order the
 * groups by the location hierarchy (depth-first, siblings alphabetical), and roll up a
 * per-location subtotal and an overall grand total of replacement value.
 *
 * Lines within a group are sorted by name (then id, for stability). Items whose location
 * cannot be resolved fall into a trailing "Unassigned" group. Only locations that actually
 * hold at least one asset become a group — empty rooms are omitted. `now` is injected (for
 * the warranty derivation and the `generatedAt` stamp) so the result is deterministic.
 *
 * @param decimals Places every rung of the document is quantised to — the reporting currency's
 * **minor unit**, not a flat 2dp (issue #292). This matters more here than anywhere else: the
 * schedule is read with a calculator, so a line printed to a precision the currency cannot
 * express (half a yen) is a figure the reader cannot reproduce. The caller resolves this from the
 * base currency (`BaseRepository.moneyDecimals()`); it defaults to {@link MONEY_DECIMALS} so a
 * caller that has no currency to hand — and every existing test — behaves exactly as before.
 */
export function buildInsuranceSchedule(
  items: readonly ScheduleItemInput[],
  locations: readonly ScheduleLocationInput[],
  now: number,
  decimals: number = MONEY_DECIMALS,
): InsuranceSchedule {
  // Bucket the resolved lines by location id (null key = unresolved → "Unassigned"), tallying
  // as we go. The tally is the *same* accumulator the streamed, paged read uses, so a whole
  // in-memory document and a page-by-page one cannot disagree about a subtotal (issue #163):
  // there is one implementation, not two that have to be proved equivalent.
  //
  // A schedule is read as a column of figures that must add up, so each rung sums the rung below
  // it *as printed* — lines are already quantised by `toScheduleLine` (issue #288). An insurer
  // adding the lines by hand gets exactly the subtotal shown.
  const linesByLocation = new Map<string | null, ScheduleLine[]>();
  const known = new Set(locations.map((l) => l.id));
  const totals = createScheduleTotals();
  for (const item of items) {
    const key = resolveScheduleGroupKey(item.locationId, known);
    const line = toScheduleLine(item, now, decimals);
    accumulateScheduleLine(totals, key, line.replacementValue, decimals);
    const bucket = linesByLocation.get(key);
    if (bucket) bucket.push(line);
    else linesByLocation.set(key, [line]);
  }

  const byName = (a: ScheduleLine, b: ScheduleLine) =>
    a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }) || a.id.localeCompare(b.id);

  // The summary owns group ordering, subtotals, the grand total and the count; this pass only
  // attaches each group's sorted lines.
  const summary = finaliseScheduleSummary(totals, locations, now, decimals);
  const groups: ScheduleLocationGroup[] = summary.groups.map((group) => ({
    locationId: group.locationId,
    locationPath: group.locationPath,
    depth: group.depth,
    lines: [...(linesByLocation.get(group.locationId) ?? [])].sort(byName),
    subtotal: group.subtotal,
  }));

  return {
    groups,
    grandTotal: summary.grandTotal,
    itemCount: summary.itemCount,
    generatedAt: summary.generatedAt,
  };
}
