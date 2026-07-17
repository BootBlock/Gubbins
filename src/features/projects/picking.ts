/**
 * Pure picking-worksheet maths (issue #121 — location-aware gather-and-tick).
 *
 * Turning a project's BOM into a walk-and-tick-off picking pass needs two derived
 * things: the overall gathering *progress* (how many lines are ticked, and whether the
 * whole worksheet is complete so finalising becomes the natural next step), and a compact
 * per-line description of *where to go* for each part. Both are pure projections over the
 * BOM lines and their per-location stock, so they live here — file-adjacent tested — and
 * the component and repository only ever consume the result. This mirrors the sibling
 * `receipts.ts` / `budget.ts` seams: the caller trusts this plan and renders it.
 */

/** A placement the worksheet can describe: a location name and the quantity sitting there. */
export interface PlacementLike {
  readonly locationName: string;
  readonly quantity: number;
}

/** A worksheet line the progress rollup can read: only its picked state matters here. */
export interface PickableLike {
  readonly picked: boolean;
}

/** The gathering progress across a project's BOM lines. */
export interface PickProgress {
  /** Total lines to gather. */
  readonly total: number;
  /** Lines ticked as physically collected. */
  readonly pickedCount: number;
  /** Lines still to gather (never negative). */
  readonly remaining: number;
  /** True only once every line is picked and there is at least one line to gather. */
  readonly allPicked: boolean;
  /** Fraction gathered in `[0, 1]`; `0` for an empty worksheet. */
  readonly fraction: number;
}

/**
 * Roll up the gathering progress over a project's BOM lines. An empty worksheet is `0/0`
 * with `allPicked: false` — "all picked" is a meaningful "ready to finalise" signal only
 * when there is actually something to gather, so it never fires on a project with no lines.
 */
export function summarisePicking(lines: readonly PickableLike[]): PickProgress {
  const total = lines.length;
  const pickedCount = lines.reduce((n, line) => n + (line.picked ? 1 : 0), 0);
  return {
    total,
    pickedCount,
    remaining: Math.max(0, total - pickedCount),
    allPicked: total > 0 && pickedCount === total,
    fraction: total === 0 ? 0 : pickedCount / total,
  };
}

/**
 * Describe where a part's stock sits as a compact, location-ordered phrase —
 * e.g. `3 in Garage · Shelf B, 2 in Loft bin 4` — for the picking worksheet's "where to
 * go" column. Placements are rendered in the order given (the repository supplies them
 * busiest-location-first); an empty list yields an empty string so the caller can show its
 * own "not in stock" affordance rather than a stray separator.
 */
export function describePlacements(placements: readonly PlacementLike[]): string {
  return placements.map((p) => `${p.quantity} in ${p.locationName}`).join(', ');
}

/** The total on-hand quantity a part has across every location it sits in. */
export function totalOnHand(placements: readonly PlacementLike[]): number {
  return placements.reduce((sum, p) => sum + p.quantity, 0);
}
