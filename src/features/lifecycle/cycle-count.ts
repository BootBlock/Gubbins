/**
 * Cycle Counting & Reconciliation maths (spec §4.4), kept pure. A user blind-counts
 * a location; the system compares each physical `counted` quantity against the
 * `expected` database quantity and surfaces the variances. Authorising the count
 * writes a Reconciliation Adjustment (an item quantity change + a `RECONCILED`
 * history row) for every non-zero variance — that persistence lives in the
 * repository; the variance arithmetic and ledger note live here.
 */

export interface CycleCountLine {
  readonly itemId: string;
  readonly name: string;
  /** The database (expected) quantity at count time. */
  readonly expected: number;
  /** The physically counted quantity entered by the user. */
  readonly counted: number;
}

export interface CycleCountVariance extends CycleCountLine {
  /** `counted - expected`: positive = surplus found, negative = shortfall. */
  readonly variance: number;
}

/** Signed variance for a single line (`counted - expected`). */
export function lineVariance(line: CycleCountLine): number {
  return line.counted - line.expected;
}

/**
 * The lines that actually drifted, each annotated with its signed variance.
 * Zero-variance lines are dropped — only these require a Reconciliation Adjustment.
 */
export function variances(lines: readonly CycleCountLine[]): CycleCountVariance[] {
  return lines
    .map((line) => ({ ...line, variance: line.counted - line.expected }))
    .filter((line) => line.variance !== 0);
}

/** Count of lines whose physical count disagrees with the database. */
export function varianceCount(lines: readonly CycleCountLine[]): number {
  return variances(lines).length;
}

/**
 * Compose the standard Reconciliation Adjustment ledger note (§4.4):
 * "Cycle count of Drawer A2: counted 8, expected 10 (adjustment -2)."
 */
export function reconciliationNote(line: CycleCountVariance, locationName: string): string {
  const sign = line.variance > 0 ? '+' : '';
  return `Cycle count of ${locationName}: counted ${line.counted}, expected ${line.expected} (adjustment ${sign}${line.variance}).`;
}
