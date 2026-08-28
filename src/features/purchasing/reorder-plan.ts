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
import type { PriceBreak } from '@/db/repositories';
import { unitCostForQty } from '@/features/inventory/supplier-cost';
import { normaliseCurrencyCode } from '@/lib/money';

/** Minimal supplier-part data needed to compute order quantities. */
export interface ReorderSupplierPart {
  readonly supplierPartId: string;
  /** The supplier this part belongs to — the identity the plan groups on. */
  readonly supplierId: string;
  /** The supplier's canonical name, carried for display only; never used as an identity. */
  readonly supplierName: string;
  readonly unitCost?: number | null;
  /**
   * The ISO-4217 code this supplier quotes the part in; `null`/absent means the base currency
   * (the `supplier_parts.currency` convention). Carried because {@link unitCost} is a bare
   * number that means nothing without it — Gubbins holds no exchange rates, so a foreign quote
   * is labelled and kept apart rather than added to a base-currency figure (issue #569).
   */
  readonly currency?: string | null;
  readonly packQty?: number | null;
  readonly minOrderQty?: number | null;
  /** Quantity price-breaks, ascending by qty; the plan costs each line at its order quantity. */
  readonly priceBreaks?: readonly PriceBreak[] | null;
}

/** One row from the low-stock shortfall feed, enriched with its preferred supplier. */
export interface ReorderShortfallRow {
  readonly itemId: string;
  readonly itemName: string;
  /**
   * Units still to order — the shortfall **already net of stock on order** (the repository
   * subtracts open-PO quantities before this reaches the builder, so a row fully covered by
   * incoming stock arrives with `shortfall <= 0` and is skipped).
   */
  readonly shortfall: number;
  /**
   * Units already on order for this item (open ORDERED/PARTIAL POs). Carried onto the plan line
   * purely so the UI can show *why* the suggested quantity was reduced — the netting itself is
   * already reflected in `shortfall`. Defaults to 0 when the feed omits it.
   */
  readonly onOrder?: number;
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
  /** Units already on order (display-only; the shortfall is already net of this). */
  readonly onOrder: number;
  readonly unitCost: number | null;
  /**
   * The currency {@link unitCost} is quoted in, normalised (upper-case, blank ⇒ `null`), where
   * `null` means the base currency. Never dropped: the figure is the supplier's own quote, so
   * anything that totals, formats, exports or orders from it has to say which currency it is.
   */
  readonly currency: string | null;
}

/** One supplier group in the reorder plan. */
export interface ReorderPlanGroup {
  /**
   * The supplier this group orders from — the identity the group was built on. `null` is the
   * Unassigned group, holding items with no preferred supplier (no PO can be drafted for it).
   */
  readonly supplierId: string | null;
  /**
   * Display name for the supplier, for UI and exports only — never an identity. The Unassigned
   * group carries {@link UNASSIGNED_SUPPLIER_NAME}.
   */
  readonly supplierName: string;
  /**
   * Stable, unique key for the group: the supplier id, or "~unassigned" for the null group.
   * Suitable as a React key or a client-side lookup handle. Not a sort key — ordering is by
   * display name (see {@link buildReorderPlan}).
   */
  readonly supplierKey: string;
  /**
   * The single currency this group's **priced** lines are quoted in, `null` for the base
   * currency — the denomination a PO drafted from the group is raised in, and the one its
   * estimated total is shown under. `null` also when the group prices nothing and when
   * {@link hasMixedCurrency} is true, so read that flag first.
   */
  readonly currency: string | null;
  /**
   * True when the group's priced lines carry more than one currency — one supplier quoting
   * some parts in EUR and others in the base currency, say. There is then no currency the
   * group's costs can be added up in, so the estimate is withheld rather than mis-summed, and
   * a drafted PO prices only the lines that match the order's own currency.
   */
  readonly hasMixedCurrency: boolean;
  readonly lines: readonly ReorderPlanLine[];
}

/** Sentinel display name for the group of items with no preferred supplier. */
export const UNASSIGNED_SUPPLIER_NAME = 'Unassigned';
/** Group key standing in for the absent supplier id, chosen so it can never collide with one. */
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
 * Grouping is on the supplier's **id**, not its name: a supplier is a first-class record, so
 * two rows belong together exactly when they point at the same supplier. Names are display
 * data here and never decide membership — renaming a supplier cannot split or merge a group,
 * and a name that merely *looks* like another's is not the same supplier.
 *
 * Empty shortfall rows (shortfall ≤ 0) are ignored — nothing to order.
 */
export function buildReorderPlan(rows: readonly ReorderShortfallRow[]): readonly ReorderPlanGroup[] {
  // Keyed by supplier id, with the null supplier folded onto a sentinel key so one Map holds
  // both cases; `supplierId` on the value is what the group actually carries out.
  const groups = new Map<
    string,
    { supplierId: string | null; supplierName: string; lines: ReorderPlanLine[] }
  >();

  for (const row of rows) {
    if (row.shortfall <= 0) continue;

    const sp = row.preferredSupplier;
    const supplierId = sp ? sp.supplierId : null;
    const supplierName = sp ? sp.supplierName : UNASSIGNED_SUPPLIER_NAME;
    const supplierKey = supplierId ?? UNASSIGNED_SUPPLIER_KEY;

    let group = groups.get(supplierKey);
    if (!group) {
      group = { supplierId, supplierName, lines: [] };
      groups.set(supplierKey, group);
    }

    const orderQty = computeOrderQty(row.shortfall, sp?.packQty, sp?.minOrderQty);

    group.lines.push({
      itemId: row.itemId,
      itemName: row.itemName,
      supplierPartId: sp?.supplierPartId ?? null,
      orderQty,
      onOrder: row.onOrder ?? 0,
      // Cost the line at the quantity being ordered so a volume price-break is reflected in
      // the drafted PO (issue #37); with no breaks this is just the flat unit cost.
      unitCost: sp
        ? unitCostForQty({ unitCost: sp.unitCost ?? null, priceBreaks: sp.priceBreaks ?? [] }, orderQty)
        : null,
      currency: normaliseCurrencyCode(sp?.currency),
    });
  }

  // Sort: named suppliers alphabetically first, Unassigned last. The comparison is on the
  // case-folded display name — the id is an opaque identifier and would order arbitrarily —
  // with the key as a final tiebreak so the order stays total and deterministic.
  const sorted = [...groups.entries()].sort(([keyA, a], [keyB, b]) => {
    if (keyA === UNASSIGNED_SUPPLIER_KEY) return 1;
    if (keyB === UNASSIGNED_SUPPLIER_KEY) return -1;
    const nameA = a.supplierName.toLowerCase();
    const nameB = b.supplierName.toLowerCase();
    if (nameA !== nameB) return nameA < nameB ? -1 : 1;
    return keyA < keyB ? -1 : keyA > keyB ? 1 : 0;
  });

  return sorted.map(([key, g]) => {
    // Only a *priced* line names a currency worth honouring — an unpriced one carries the
    // part's code but no figure denominated in it, so counting it would report a group as
    // mixed on the strength of a quote that contributes nothing.
    const codes = new Set(g.lines.filter((l) => l.unitCost !== null).map((l) => l.currency));
    const hasMixedCurrency = codes.size > 1;
    return {
      supplierId: g.supplierId,
      supplierName: g.supplierName,
      supplierKey: key,
      currency: hasMixedCurrency ? null : ([...codes][0] ?? null),
      hasMixedCurrency,
      lines: g.lines,
    } satisfies ReorderPlanGroup;
  });
}
