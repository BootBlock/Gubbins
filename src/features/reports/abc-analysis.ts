/**
 * Pure ABC (Pareto) classification of inventory by annual consumption value
 * (advanced-analytics Phase 74). Like its sibling {@link ./reports.ts}, this module is kept
 * free of React, repositories, SQL and the DOM so every calculation is unit-tested in
 * isolation (Protocol Beta); a repository pulls the minimal raw rows from SQLite and hands
 * them to {@link classifyAbc}, and the UI formats the resulting DTOs with `useFormatters`.
 *
 * ABC analysis ranks items by the value they consume over a trailing annual window and
 * splits the ranked list at two cumulative-value boundaries: the small head of items that
 * accounts for the bulk of the value is class A ("the vital few"), the middle is B, and the
 * long, low-value tail is C ("the trivial many"). The classification is a read-only
 * projection over data already stored — there is no schema change in this phase.
 *
 * Valuation honours the single internal "effective unit cost" lookup ({@link effectiveUnitCost})
 * shared with the §3 reports, so the "manual cost wins, else preferred supplier cost, else
 * unpriced" rule lives in exactly one place across the app and is never re-implemented here.
 */
import { effectiveUnitCost, type ValuedUnit } from './reports';

/** Default upper boundary (cumulative value share) for class A — the top ~80% of value. */
const DEFAULT_A_CUTOFF = 0.8;
/** Default upper boundary (cumulative value share) for class B — value up to ~95%. */
const DEFAULT_B_CUTOFF = 0.95;

/**
 * One item presented for classification. Extends {@link ValuedUnit} so its cost flows through
 * {@link effectiveUnitCost} unchanged; the repository selects this narrow projection rather
 * than the full `Item`.
 */
export interface AbcInput extends ValuedUnit {
  /** Stable item id (echoed onto the resulting line). */
  readonly id: string;
  /** Human-readable item name (also the deterministic tiebreak key). */
  readonly name: string;
  /** Units consumed over the annual window (a positive magnitude; negatives clamp to 0). */
  readonly consumedUnits: number;
}

/** A classified line: one item with its annual value, running share and assigned tier. */
export interface AbcLine {
  readonly id: string;
  readonly name: string;
  /** `max(0, consumedUnits) * effectiveUnitCost` — the item's annual consumption value. */
  readonly annualValue: number;
  /**
   * Running cumulative share of `totalValue` **after** this item is added, in `0..1`. Always
   * `0` when `totalValue === 0`. Because lines are value-descending this is non-decreasing.
   */
  readonly cumulativeShare: number;
  /** The Pareto class the running share lands in (`<= aCutoff` A, `<= bCutoff` B, else C). */
  readonly tier: 'A' | 'B' | 'C';
}

/** Per-tier roll-up: how many items fell into a tier and the value they represent. */
export interface AbcTierSummary {
  readonly tier: 'A' | 'B' | 'C';
  /** Number of lines assigned to this tier. */
  readonly itemCount: number;
  /** Sum of `annualValue` across this tier's lines. */
  readonly totalValue: number;
  /** This tier's value as a share of the overall `totalValue` (`0..1`; `0` when total is 0). */
  readonly valueShare: number;
}

/** The complete ABC report: ranked lines, the three tier roll-ups and the inputs used. */
export interface AbcReport {
  /** Every line, value-descending (A → C), tiebroken by name. */
  readonly lines: readonly AbcLine[];
  /** The three tier summaries; A/B/C are always present, zeroed when a tier is empty. */
  readonly tiers: {
    readonly A: AbcTierSummary;
    readonly B: AbcTierSummary;
    readonly C: AbcTierSummary;
  };
  /** `SUM(annualValue)` across all lines — the denominator for every share. */
  readonly totalValue: number;
  /** The effective cumulative-share boundaries actually applied (after clamping). */
  readonly thresholds: { readonly aCutoff: number; readonly bCutoff: number };
}

/**
 * Resolve the two cumulative-share cutoffs, defending against nonsensical callers. Each
 * cutoff falls back to its default when absent or non-finite, is clamped into `(0, 1]`, and
 * `aCutoff` is finally clamped to be `<= bCutoff` so the invariant `0 < aCutoff <= bCutoff <= 1`
 * always holds (a caller passing `aCutoff > bCutoff` collapses the B band to empty rather
 * than throwing).
 */
function resolveCutoffs(opts?: { aCutoff?: number; bCutoff?: number }): {
  aCutoff: number;
  bCutoff: number;
} {
  const clampUnit = (value: number | undefined, fallback: number): number => {
    if (value == null || !Number.isFinite(value)) return fallback;
    // Keep strictly above 0 so an all-A or degenerate boundary can never appear at 0.
    return Math.min(1, Math.max(Number.EPSILON, value));
  };
  const bCutoff = clampUnit(opts?.bCutoff, DEFAULT_B_CUTOFF);
  const aCutoff = Math.min(clampUnit(opts?.aCutoff, DEFAULT_A_CUTOFF), bCutoff);
  return { aCutoff, bCutoff };
}

/** An empty tier summary for `tier`, used when a tier gathers no lines. */
function emptyTier(tier: 'A' | 'B' | 'C'): AbcTierSummary {
  return { tier, itemCount: 0, totalValue: 0, valueShare: 0 };
}

/**
 * Classify `items` into A/B/C tiers by annual consumption value (Pareto). Each item's value is
 * `max(0, consumedUnits) * effectiveUnitCost(item)`; lines are sorted by value descending and
 * tiebroken by `name.localeCompare`. Walking that ranked list, the **running** cumulative value
 * after each item — divided by `totalValue` — decides its tier: `<= aCutoff` → A, else
 * `<= bCutoff` → B, else C (the item that crosses a boundary belongs to the lower tier it pushes
 * into, the standard Pareto convention).
 *
 * Edge cases are handled defensively and never divide by zero:
 * - A line whose `annualValue === 0` is always C, regardless of its rank.
 * - When `totalValue === 0` (empty input, or every item unpriced/zero) every line is C with
 *   `cumulativeShare === 0`, and every tier's `valueShare === 0`.
 * - Cutoffs are clamped to `0 < aCutoff <= bCutoff <= 1` (see {@link resolveCutoffs}); the
 *   applied values are echoed back in {@link AbcReport.thresholds}.
 */
export function classifyAbc(
  items: readonly AbcInput[],
  opts?: { aCutoff?: number; bCutoff?: number },
): AbcReport {
  const thresholds = resolveCutoffs(opts);

  // Value every item once, then rank value-descending with a stable name tiebreak.
  const valued = items.map((item) => ({
    id: item.id,
    name: item.name,
    annualValue: Math.max(0, item.consumedUnits) * effectiveUnitCost(item),
  }));
  valued.sort((a, b) =>
    b.annualValue !== a.annualValue ? b.annualValue - a.annualValue : a.name.localeCompare(b.name),
  );

  const totalValue = valued.reduce((sum, line) => sum + line.annualValue, 0);

  const lines: AbcLine[] = [];
  // Aggregate the three tier roll-ups as we assign each line.
  const acc: Record<'A' | 'B' | 'C', { itemCount: number; totalValue: number }> = {
    A: { itemCount: 0, totalValue: 0 },
    B: { itemCount: 0, totalValue: 0 },
    C: { itemCount: 0, totalValue: 0 },
  };

  let cumulativeValue = 0;
  let index = 0;
  for (const line of valued) {
    cumulativeValue += line.annualValue;
    const cumulativeShare = totalValue > 0 ? cumulativeValue / totalValue : 0;
    const isFirst = index === 0;
    index += 1;

    let tier: 'A' | 'B' | 'C';
    if (line.annualValue <= 0 || totalValue <= 0) {
      // No value to rank → always the trivial tail.
      tier = 'C';
    } else if (cumulativeShare <= thresholds.aCutoff || isFirst) {
      // The running share lands within the A band — or this is the top-ranked item, which
      // always anchors A even when it alone already exceeds `aCutoff` (e.g. a single dominant
      // item, or a one-item list). Without this the "vital few" head could be empty.
      tier = 'A';
    } else if (cumulativeShare <= thresholds.bCutoff) {
      tier = 'B';
    } else {
      tier = 'C';
    }

    acc[tier].itemCount += 1;
    acc[tier].totalValue += line.annualValue;
    lines.push({ id: line.id, name: line.name, annualValue: line.annualValue, cumulativeShare, tier });
  }

  const summarise = (tier: 'A' | 'B' | 'C'): AbcTierSummary => {
    const bucket = acc[tier];
    if (bucket.itemCount === 0) return emptyTier(tier);
    return {
      tier,
      itemCount: bucket.itemCount,
      totalValue: bucket.totalValue,
      valueShare: totalValue > 0 ? bucket.totalValue / totalValue : 0,
    };
  };

  return {
    lines,
    tiers: { A: summarise('A'), B: summarise('B'), C: summarise('C') },
    totalValue,
    thresholds,
  };
}
