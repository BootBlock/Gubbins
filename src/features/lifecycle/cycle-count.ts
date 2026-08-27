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

// --- Serialised audit (§4.4) ----------------------------------------------------
//
// A DISCRETE count reconciles a *quantity*; a SERIALISED audit reconciles
// *presence* — each instance is a qty-1 record, so the question is "is this exact
// physical unit here?". The user walks the location and flags any instance they
// cannot find as MISSING; authorising soft-deletes those (reversible) rather than
// adjusting a quantity. The arithmetic here is a present/missing partition; the
// persistence (soft-delete + ledger entry) lives in the repository.

export type SerialisedPresence = 'PRESENT' | 'MISSING';

export interface SerialisedAuditLine {
  readonly itemId: string;
  readonly name: string;
  /** Instance number (1..N) distinguishing serialised clones; null if unset. */
  readonly serialNo: number | null;
}

/** Display label for a serialised instance: "Multimeter #3", or the bare name. */
export function serialisedLabel(line: SerialisedAuditLine): string {
  return line.serialNo != null ? `${line.name} #${line.serialNo}` : line.name;
}

/**
 * The instances the user flagged as not found — the only ones needing a
 * Reconciliation Adjustment. An instance is missing only when explicitly marked
 * `'MISSING'`; anything else (present, or untouched) is left alone, so the
 * soft-deleting write never fires on a unit the auditor did not actively flag.
 */
export function missingInstances(
  lines: readonly SerialisedAuditLine[],
  presence: Readonly<Record<string, SerialisedPresence>>,
): SerialisedAuditLine[] {
  return lines.filter((line) => presence[line.itemId] === 'MISSING');
}

/**
 * Compose the serialised-audit Reconciliation Adjustment ledger note (§4.4):
 * "Serialised audit of Drawer A2: Multimeter #3 not found — marked missing."
 */
export function serialisedAuditNote(line: SerialisedAuditLine, locationName: string): string {
  return `Serialised audit of ${locationName}: ${serialisedLabel(line)} not found — marked missing.`;
}

// --- Count coverage (issue #637) ------------------------------------------------
//
// A blind count deliberately *skips* a line the auditor left blank rather than reading
// it as zero — that is the safe reading, and `variances()` above never sees such a line.
// The cost of that safety is that "counted every line and found no drift" and "typed
// nothing at all" produce an identical result: no variance, no adjustment. So the sheet's
// **coverage** is derived separately and carried alongside the variances, and it is what
// decides whether the location may be recorded as counted at all.
//
// Coverage is measured over the DISCRETE lines only. A serialised instance carries no
// blank state — presence defaults to PRESENT until the auditor flags it missing — so
// there is nothing to distinguish "confirmed present" from "not looked at" without
// changing that toggle into a tri-state, which is a separate change.

/** How much of a location's discrete count sheet the auditor actually filled in. */
export interface CountCoverage {
  /** Discrete lines on the sheet. */
  readonly total: number;
  /** Lines with a quantity entered. */
  readonly counted: number;
  /** Lines left blank, and therefore not counted at all. */
  readonly blank: number;
  /** Every line was counted. True for a sheet with no discrete lines to count. */
  readonly isComplete: boolean;
}

/**
 * Measure how many of a sheet's lines carry an entered quantity. A line counts as
 * entered on exactly the same test the variance path uses — a non-empty trimmed
 * value — so coverage and variance can never disagree about which lines participated.
 */
export function countCoverage(
  lineKeys: readonly string[],
  counts: Readonly<Record<string, string>>,
): CountCoverage {
  const total = lineKeys.length;
  const counted = lineKeys.reduce((acc, key) => acc + (counts[key]?.trim().length ? 1 : 0), 0);
  return { total, counted, blank: total - counted, isComplete: counted === total };
}
