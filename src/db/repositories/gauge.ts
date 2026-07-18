/**
 * Consumable-Gauge mathematics (spec §4.1), kept pure and isolated from the
 * generic item logic. These functions are shared by the repository (computing
 * derived state on read) and the React update UI (converting an absolute
 * "weigh-in" into the relative delta that §4.1.2 mandates be stored).
 */

/** `percentage_remaining = (current_net_value / gross_capacity) * 100` (§4.1.1). */
export function percentageRemaining(currentNetValue: number, grossCapacity: number): number {
  if (!(grossCapacity > 0)) return 0;
  return (currentNetValue / grossCapacity) * 100;
}

/** `current_gross_weight = current_net_value + tare_weight` (§4.1.1). */
export function currentGrossWeight(currentNetValue: number, tareWeight: number): number {
  return currentNetValue + tareWeight;
}

/**
 * Convert an Absolute "Weigh-In" (§4.1.2) into the relative delta that must be
 * written to the database and Activity Log for CRDT integrity. The user places
 * the item on a scale and reads the *total gross weight*; we subtract the tare to
 * get the new net value, then return the signed difference from the current net.
 *
 * e.g. scale reads 650 g, tare 250 g, current net 445 g →
 *      new net = 400 g, delta = -45 g.
 */
export function weighInToDelta(
  grossWeightOnScale: number,
  currentNetValue: number,
  tareWeight: number,
): number {
  const newNetValue = grossWeightOnScale - tareWeight;
  return newNetValue - currentNetValue;
}

/**
 * Compose the standard weigh-in ledger note (spec §4.1.3):
 * "Calibrated gross weight to 650g (Calculated usage: -45g)".
 */
export function weighInNote(grossWeightOnScale: number, delta: number, unit: string): string {
  const sign = delta > 0 ? '+' : '';
  return `Calibrated gross weight to ${grossWeightOnScale}${unit} (Calculated usage: ${sign}${delta}${unit})`;
}

/**
 * Clamp a net value to the physically valid range `[0, grossCapacity]` (§4.1.1).
 * A gauge can never hold less than empty nor more than a full unit, so an overfilled
 * weigh-in or an over-eager refill is capped at capacity rather than stored as a
 * nonsensical `percentage_remaining > 100%`. A non-positive capacity (mis-configured
 * item) only enforces the lower bound.
 */
export function clampNetValue(value: number, grossCapacity: number): number {
  const lowerBounded = Math.max(0, value);
  return grossCapacity > 0 ? Math.min(grossCapacity, lowerBounded) : lowerBounded;
}

/**
 * The amount needed to top a gauge back up to a full unit (§4.1.2 refill): the
 * shortfall `grossCapacity - currentNetValue`, never negative. Drives the UI's
 * "Fill to full" shortcut (e.g. mounting a fresh spool).
 */
export function refillToFullAmount(currentNetValue: number, grossCapacity: number): number {
  return Math.max(0, grossCapacity - currentNetValue);
}

/**
 * Convert a refill ("I added this much material") into the relative delta that is
 * actually applied after capacity clamping (§4.1.2). Adding past a full unit only
 * tops it off to capacity, so the returned delta is the *clamped* difference — the
 * value the Activity Log and CRDT replay must record, never the raw requested add.
 */
export function refillDelta(addedAmount: number, currentNetValue: number, grossCapacity: number): number {
  const clampedNext = clampNetValue(currentNetValue + addedAmount, grossCapacity);
  return clampedNext - currentNetValue;
}

/**
 * Compose the refill ledger note (spec §4.1.3 style): the applied (clamped) amount
 * added and the resulting net level, e.g. "Refilled +600g (now 1000g)".
 */
export function refillNote(appliedDelta: number, newNetValue: number, unit: string): string {
  const sign = appliedDelta > 0 ? '+' : '';
  return `Refilled ${sign}${appliedDelta}${unit} (now ${newNetValue}${unit})`;
}

/**
 * The intuitive fill levels offered by the "Estimate" quick-set (issue #95). Rather
 * than weighing a half-empty filament spool or guessing how much detergent is left,
 * the user picks a level and the gauge snaps to that coefficient of its full
 * capacity — enough precision to drive the low-stock gauge alert without a scale.
 * Ordered full → empty (the slider runs the same way). The `percent` values are the
 * single source of truth for the mapping; the UI renders their labels.
 */
export const GAUGE_LEVELS = [
  { key: 'full', label: 'Full', percent: 100 },
  { key: 'mostly', label: 'Mostly full', percent: 75 },
  { key: 'half', label: 'Half', percent: 50 },
  { key: 'low', label: 'Low', percent: 25 },
  { key: 'empty', label: 'Empty', percent: 0 },
] as const;
export type GaugeLevelKey = (typeof GAUGE_LEVELS)[number]['key'];

/**
 * The net value a chosen fill level (`percent`, 0–100) maps to for a gauge of this
 * capacity, clamped to the valid `[0, grossCapacity]` range (§4.1.1). `50` → half a
 * full unit. Drives the "Estimate" quick-set (issue #95).
 */
export function estimateNetValue(percent: number, grossCapacity: number): number {
  return clampNetValue((percent / 100) * grossCapacity, grossCapacity);
}

/**
 * Convert a chosen fill level into the relative net-value delta the ledger stores
 * (§4.1.2 / issue #95): the signed difference between the level's target net and the
 * current net. Like every other gauge mode, only this delta reaches the database and
 * Activity Log — the delta-CRDT integrity rule (§7.3).
 */
export function estimateDelta(percent: number, currentNetValue: number, grossCapacity: number): number {
  return estimateNetValue(percent, grossCapacity) - currentNetValue;
}

/**
 * Compose the estimate ledger note: the level chosen and the resulting net level,
 * e.g. "Estimated Half (~50%, now 500g)".
 */
export function estimateNote(label: string, percent: number, newNetValue: number, unit: string): string {
  return `Estimated ${label} (~${percent}%, now ${newNetValue}${unit})`;
}

/**
 * The valid range for a gauge's attrition rate (issue #89), as a percentage *of the
 * amount asked for*. `0` and an unset rate behave identically; the ceiling of `100`
 * allows a draw to at most double, which comfortably covers real trimming and spillage
 * losses while keeping an obvious typo (`1000`) from silently emptying a gauge.
 */
export const ATTRITION_PERCENT_BOUNDS = { min: 0, max: 100 } as const;

/** Whether a value is usable as an attrition rate — finite and inside the bounds. */
export function isValidAttritionPercent(value: number): boolean {
  return (
    Number.isFinite(value) && value >= ATTRITION_PERCENT_BOUNDS.min && value <= ATTRITION_PERCENT_BOUNDS.max
  );
}

/** The outcome of applying an attrition rate to a requested consumption (issue #89). */
export interface AttritionDraw {
  /** The amount the user actually wants to *use*. */
  readonly requested: number;
  /** The extra amount lost to waste on top of the requested amount. */
  readonly waste: number;
  /** What actually leaves the gauge: `requested + waste`. */
  readonly total: number;
}

/**
 * Apply a per-item attrition rate to a requested consumption (issue #89).
 *
 * Some materials cost more than you use: taking 100 g of flour out of the bag really
 * removes 110 g once the dusting left on the board and the bag is counted. The rate is
 * *proportional* — a scrap factor rather than a fixed per-use adder — because that is
 * how both recipe costing (yield percentage) and manufacturing BOMs (component scrap)
 * model it, and because it degrades sensibly at small draws where a flat overhead would
 * dominate.
 *
 * A null/absent or zero rate is the identity, so items that opt out are unaffected.
 * Negative or non-finite requests yield a zero draw rather than an inverted one.
 */
export function attritionDraw(requestedAmount: number, attritionPercent: number | null): AttritionDraw {
  if (!Number.isFinite(requestedAmount) || requestedAmount <= 0) {
    return { requested: 0, waste: 0, total: 0 };
  }
  const rate = attritionPercent !== null && isValidAttritionPercent(attritionPercent) ? attritionPercent : 0;
  // Multiplying by a percentage introduces float noise that plain addition never does
  // (33 × 15% = 4.949999999999999), and these numbers are written verbatim into an
  // append-only ledger note. Attrition is an estimate to begin with, so round to a
  // precision far finer than any real scale reads — 1e-4 of a gram is 0.1 mg. The sum is
  // rounded too, not just the waste: 12.3 + 0.861 lands on 13.161000000000001 unaided.
  const waste = roundAmount(requestedAmount * (rate / 100));
  return { requested: requestedAmount, waste, total: roundAmount(requestedAmount + waste) };
}

/** Round a gauge amount to 1e-4, the shared precision floor for attrition arithmetic. */
function roundAmount(value: number): number {
  return Math.round(value * 1e4) / 1e4;
}

/**
 * Compose the consumption ledger note when attrition applied (issue #89), naming both
 * numbers: what was used and what it actually cost, e.g.
 * "Used 100g (+10g waste, 110g total)". Without this the Activity Log would show a
 * 110 g draw against a user who typed 100, which reads as a bug.
 */
export function attritionNote(draw: AttritionDraw, unit: string): string {
  return `Used ${draw.requested}${unit} (+${draw.waste}${unit} waste, ${draw.total}${unit} total)`;
}

/** A gauge item's full configuration plus the level currently sitting in it (§4.1.1). */
export interface GaugeConfig {
  readonly unitOfMeasure: string;
  readonly grossCapacity: number;
  readonly tareWeight: number;
  readonly currentNetValue: number;
  /**
   * Proportional waste applied to a requested consumption (issue #89), or `null` when the
   * item has no attrition — the default, and indistinguishable from `0` in the maths.
   */
  readonly attritionPercent: number | null;
}

/**
 * A requested change to a gauge's configuration (issue #69). Every field is optional —
 * an omitted one is left exactly as it was, matching `UpdateItemInput`'s partial shape.
 */
export interface GaugeConfigChange {
  readonly unitOfMeasure?: string;
  readonly grossCapacity?: number;
  readonly tareWeight?: number;
  /**
   * The attrition rate (issue #89). Unlike its siblings this is *tri-state*: `undefined`
   * leaves the existing rate alone (the partial-update contract above), while an explicit
   * `null` clears it back to "no attrition". Without that distinction there would be no
   * way to turn the feature back off once switched on.
   */
  readonly attritionPercent?: number | null;
}

/** The resolved outcome of applying a {@link GaugeConfigChange} to a {@link GaugeConfig}. */
export interface GaugeReconfiguration extends GaugeConfig {
  /**
   * The signed net-value change forced by the new capacity, if any. Shrinking a gauge's
   * capacity below the material currently in it has to spill the excess — there is
   * physically nowhere for it to sit — and that spill is a real stock movement, so it is
   * recorded as a delta exactly like a consumption (the §7.3 delta-CRDT rule). Zero
   * whenever the capacity grew, held still, or still exceeds the current net.
   */
  readonly netValueDelta: number;
  /** Whether anything actually differs from the current configuration. */
  readonly changed: boolean;
}

/**
 * Resolve a requested gauge reconfiguration (issue #69) — the pure half of
 * `reconfigureGauge`, so the clamping and no-op detection are unit-tested without a
 * database.
 *
 * A gauge's unit, capacity and tare are fixed at creation today, which makes a typo
 * ("g" where "m" was meant) or a swap to a differently-sized spool unfixable without
 * deleting the item and losing its history. Correcting them is a plain configuration
 * edit — but capacity is the one field that can invalidate stored state, because
 * `current_net_value` must never exceed it (§4.1.1), hence the clamp.
 *
 * Validation is the caller's job; this assumes already-valid inputs.
 */
export function resolveGaugeReconfiguration(
  current: GaugeConfig,
  change: GaugeConfigChange,
): GaugeReconfiguration {
  const unitOfMeasure = change.unitOfMeasure ?? current.unitOfMeasure;
  const grossCapacity = change.grossCapacity ?? current.grossCapacity;
  const tareWeight = change.tareWeight ?? current.tareWeight;
  // Tri-state: `??` would collapse an explicit null (clear the rate) into "leave alone",
  // making the feature impossible to switch back off.
  const attritionPercent =
    change.attritionPercent === undefined ? current.attritionPercent : change.attritionPercent;

  // Only capacity constrains the stored level. Tare shifts what a *scale* reads, not how
  // much material is in the gauge, so re-taring deliberately leaves the net value alone.
  const currentNetValue = clampNetValue(current.currentNetValue, grossCapacity);
  const netValueDelta = currentNetValue - current.currentNetValue;

  return {
    unitOfMeasure,
    grossCapacity,
    tareWeight,
    currentNetValue,
    attritionPercent,
    netValueDelta,
    changed:
      unitOfMeasure !== current.unitOfMeasure ||
      grossCapacity !== current.grossCapacity ||
      tareWeight !== current.tareWeight ||
      attritionPercent !== current.attritionPercent,
  };
}

/**
 * Compose the reconfiguration ledger note (§4.1.3 style) — only the fields that actually
 * changed, plus the forced spill when a smaller capacity displaced material, e.g.
 * "Gauge reconfigured: capacity 1000g → 750g (250g over capacity discarded)".
 */
export function reconfigureNote(current: GaugeConfig, next: GaugeReconfiguration): string {
  // Each side of an arrow is labelled with the unit it was actually recorded in: the old
  // capacity of a spool relabelled g → m was grams, and saying "1000m → 600m" would put a
  // plain falsehood in an append-only ledger.
  const before = current.unitOfMeasure;
  const after = next.unitOfMeasure;
  const parts: string[] = [];
  if (after !== before) {
    parts.push(`unit ${before} → ${after}`);
  }
  if (next.grossCapacity !== current.grossCapacity) {
    parts.push(`capacity ${current.grossCapacity}${before} → ${next.grossCapacity}${after}`);
  }
  if (next.tareWeight !== current.tareWeight) {
    parts.push(`tare ${current.tareWeight}${before} → ${next.tareWeight}${after}`);
  }
  if (next.attritionPercent !== current.attritionPercent) {
    const describe = (rate: number | null) => (rate === null ? 'none' : `${rate}%`);
    parts.push(`attrition ${describe(current.attritionPercent)} → ${describe(next.attritionPercent)}`);
  }
  // Guard the degenerate call: the repository only reaches here when something changed, but
  // this is exported, and "Gauge reconfigured: " with an empty tail is worse than saying so.
  if (parts.length === 0) return 'Gauge reconfigured: no change';
  const spill = next.netValueDelta < 0 ? ` (${-next.netValueDelta}${after} over capacity discarded)` : '';
  return `Gauge reconfigured: ${parts.join(', ')}${spill}`;
}
