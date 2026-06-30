/**
 * Pure reorder-plan builder (spec §4 procurement automation; Phase 65).
 *
 * Converts a list of "low-stock shortfall" rows (each optionally carrying a preferred
 * supplier) into a grouped structure ready for bulk DRAFT PO creation: one group per
 * preferred supplier, with an "Unassigned" group at the end for items that have no
 * preferred supplier linked.
 *
 * No DB, no clock — fully unit-testable in isolation. The repository layer feeds it;
 * the UI consumes it; `PurchaseOrderRepository.createDraftFromReorderPlan` writes it.
 */

/** Minimal supplier-part data needed to compute order quantities. */
export interface ReorderSupplierPart {
  readonly supplierPartId: string;
  readonly supplierName: string;
  readonly unitCost?: number | null;
  readonly packQty?: number | null;
  readonly minOrderQty?: number | null;
}

/** One row from the low-stock shortfall feed, enriched with its preferred supplier. */
export interface ReorderShortfallRow {
  readonly itemId: string;
  readonly itemName: string;
  /** Units below the reorder point (already computed by `shortfall()`). */
  readonly shortfall: number;
  /** The preferred supplier-part row, or undefined/null when none is marked. */
  readonly preferredSupplier?: ReorderSupplierPart | null;
}

/** One line within a reorder plan group, ready to become a PO line. */
export interface ReorderPlanLine {
  readonly itemId: string;
  readonly itemName: string;
  /**
   * The supplier-part id to stamp on the PO line, or null for the Unassigned group
   * (where no PO can be drafted automatically).
   */
  readonly supplierPartId: string | null;
  /** Computed order quantity: at least the shortfall, at least the MOQ, rounded up to a
   * whole pack (see {@link computeOrderQty}). */
  readonly orderQty: number;
  readonly unitCost: number | null;
}

/** One supplier group in the reorder plan. */
export interface ReorderPlanGroup {
  /**
   * Canonical display name for the supplier.  "Unassigned" is the sentinel value for
   * the group that holds items with no preferred supplier.
   */
  readonly supplierName: string;
  /**
   * Stable sort key (lower-cased supplier name; "~unassigned" sorts last
   * deterministically without any locale-dependent behaviour).
   */
  readonly supplierKey: string;
  readonly lines: readonly ReorderPlanLine[];
}

/** Sentinel supplier name / key for items with no preferred supplier. */
export const UNASSIGNED_SUPPLIER_NAME = 'Unassigned';
const UNASSIGNED_SUPPLIER_KEY = '~unassigned';

/**
 * Round `needed` up to the next whole multiple of `packQty`.
 *
 * If `packQty` is absent, ≤ 1, or non-finite the raw `needed` is returned unchanged
 * (rounding by 1-unit packs is a no-op). `needed` must already be ≥ 1.
 *
 * @example
 * roundUpToPack(7, 5)  // → 10  (2 packs of 5)
 * roundUpToPack(5, 5)  // → 5   (exact pack)
 * roundUpToPack(3, 1)  // → 3   (no-op)
 * roundUpToPack(3, null) // → 3 (no-op)
 */
export function roundUpToPack(needed: number, packQty: number | null | undefined): number {
  if (!packQty || packQty <= 1 || !Number.isFinite(packQty)) return needed;
  return Math.ceil(needed / packQty) * packQty;
}

/**
 * Compute the order quantity for one shortfall row.
 *
 * Rules (in order):
 * 1. Start with the `shortfall` (must order at least this many to reach the reorder point).
 * 2. Apply the MOQ: if `minOrderQty` exceeds the shortfall, use the MOQ instead.
 * 3. Round up to a whole number of packs when `packQty > 1`.
 */
export function computeOrderQty(
  shortfall: number,
  packQty: number | null | undefined,
  minOrderQty: number | null | undefined,
): number {
  const moq = minOrderQty != null && minOrderQty > 0 ? minOrderQty : 0;
  const needed = Math.max(shortfall, moq);
  return roundUpToPack(needed, packQty);
}

/**
 * Build a deterministic reorder plan from a set of shortfall rows.
 *
 * Groups the rows by preferred supplier (items with no preferred supplier go into the
 * "Unassigned" group), computes the order quantity for each line, and returns the groups
 * sorted alphabetically by supplier name with Unassigned last.
 *
 * Empty shortfall rows (shortfall ≤ 0) are ignored — nothing to order.
 */
export function buildReorderPlan(rows: readonly ReorderShortfallRow[]): readonly ReorderPlanGroup[] {
  // Group rows by supplier key.
  const groups = new Map<string, { supplierName: string; lines: ReorderPlanLine[] }>();

  for (const row of rows) {
    if (row.shortfall <= 0) continue;

    const sp = row.preferredSupplier;
    const supplierName = sp ? sp.supplierName : UNASSIGNED_SUPPLIER_NAME;
    // Group key is the case-folded supplier name. Safe because each supplier is one
    // canonical `supplier_parts.supplier_name` row, so two items' preferred suppliers
    // never differ only by case — do not add locale-sensitive name normalisation here
    // without preserving that invariant.
    const supplierKey = sp ? supplierName.toLowerCase() : UNASSIGNED_SUPPLIER_KEY;

    let group = groups.get(supplierKey);
    if (!group) {
      group = { supplierName, lines: [] };
      groups.set(supplierKey, group);
    }

    const orderQty = computeOrderQty(
      row.shortfall,
      sp?.packQty,
      sp?.minOrderQty,
    );

    group.lines.push({
      itemId: row.itemId,
      itemName: row.itemName,
      supplierPartId: sp?.supplierPartId ?? null,
      orderQty,
      unitCost: sp?.unitCost ?? null,
    });
  }

  // Sort: named suppliers alphabetically first, Unassigned last.
  const sortedKeys = [...groups.keys()].sort((a, b) => {
    if (a === UNASSIGNED_SUPPLIER_KEY) return 1;
    if (b === UNASSIGNED_SUPPLIER_KEY) return -1;
    return a < b ? -1 : a > b ? 1 : 0;
  });

  return sortedKeys.map((key) => {
    const g = groups.get(key)!;
    return {
      supplierName: g.supplierName,
      supplierKey: key,
      lines: g.lines,
    } satisfies ReorderPlanGroup;
  });
}
