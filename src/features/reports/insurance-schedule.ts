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
 * Valuation flows through the single {@link effectiveUnitCost} seam (manual cost wins, else
 * the preferred supplier cost, else 0). Each input line also carries an optional
 * {@link ScheduleItemInput.currentValuePerUnit} override that, when set, *wins* over the
 * replacement cost — the clean forward-hook for G9 (manual current / market value) so an
 * appreciating asset can be scheduled at today's worth. Until G9 lands nothing populates
 * it and valuation falls back to the replacement-cost seam.
 */
import { effectiveUnitCost, type ValuedUnit } from './reports';
import { effectiveUnitValue } from '@/features/inventory/valuation';
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
 * (extends {@link ValuedUnit} so it flows through {@link effectiveUnitCost}). Only the
 * fields the document actually shows or values are carried, keeping the helper testable.
 */
export interface ScheduleItemInput extends ValuedUnit {
  readonly id: string;
  readonly name: string;
  /** SERIALISED instance number (1..N), or null for a non-serialised item. */
  readonly serialNo: number | null;
  /** Operational condition (Mint/Good/…), or null when untracked. */
  readonly condition: Condition | null;
  /** On-hand quantity; the line value is `quantity × per-unit value`. */
  readonly quantity: number;
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
   * wins over {@link effectiveUnitCost} so an appreciating asset is scheduled at today's
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
  readonly acquiredAt: string | null;
  readonly purchasePrice: number | null;
  readonly warranty: WarrantyStatus;
  /** `quantity × per-unit value` (manual current value if set, else effective replacement cost). */
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

/** Resolve a single asset input to its display line, valuing it through the cost seams. */
function toLine(item: ScheduleItemInput, now: number): ScheduleLine {
  const qty = Math.max(0, item.quantity);
  // Manual current value (G9) wins; otherwise the effective replacement cost per unit. The
  // override precedence is the single `effectiveUnitValue` seam shared with the valuation report.
  const unitValue = effectiveUnitValue(item.currentValuePerUnit, effectiveUnitCost(item));
  return {
    id: item.id,
    name: item.name,
    serialNo: item.serialNo,
    condition: item.condition,
    quantity: item.quantity,
    acquiredAt: item.acquiredAt,
    purchasePrice: item.purchasePrice,
    // Only `warrantyExpiresAt` drives the status; the rest of the slice is unused here
    // (depreciation is never applied — value flows through `effectiveUnitCost`).
    warranty: warrantyStatus(
      {
        acquiredAt: item.acquiredAt,
        warrantyExpiresAt: item.warrantyExpiresAt,
        purchasePrice: item.purchasePrice,
        depreciationMonths: null,
      },
      now,
    ),
    replacementValue: qty * Math.max(0, unitValue),
    thumbnail: item.thumbnail ?? null,
  };
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
 */
export function buildInsuranceSchedule(
  items: readonly ScheduleItemInput[],
  locations: readonly ScheduleLocationInput[],
  now: number,
): InsuranceSchedule {
  // Bucket the resolved lines by location id (null key = unresolved → "Unassigned").
  const linesByLocation = new Map<string | null, ScheduleLine[]>();
  const known = new Set(locations.map((l) => l.id));
  for (const item of items) {
    const key = item.locationId != null && known.has(item.locationId) ? item.locationId : null;
    const line = toLine(item, now);
    const bucket = linesByLocation.get(key);
    if (bucket) bucket.push(line);
    else linesByLocation.set(key, [line]);
  }

  const byName = (a: ScheduleLine, b: ScheduleLine) =>
    a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }) || a.id.localeCompare(b.id);

  const makeGroup = (
    locationId: string | null,
    locationPath: string,
    depth: number,
    lines: ScheduleLine[],
  ): ScheduleLocationGroup => {
    const sorted = [...lines].sort(byName);
    const subtotal = sorted.reduce((sum, l) => sum + l.replacementValue, 0);
    return { locationId, locationPath, depth, lines: sorted, subtotal };
  };

  const groups: ScheduleLocationGroup[] = [];
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
  return { groups, grandTotal, itemCount, generatedAt: now };
}
