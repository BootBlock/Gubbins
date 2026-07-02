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
