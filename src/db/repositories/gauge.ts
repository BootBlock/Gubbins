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
