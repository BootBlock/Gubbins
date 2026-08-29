/**
 * Cycle Counting & Reconciliation maths (spec §4.4), kept pure. A user blind-counts
 * a location; the system compares each physical `counted` quantity against the
 * `expected` database quantity and surfaces the variances. Authorising the count
 * writes a Reconciliation Adjustment (an item quantity change + a `RECONCILED`
 * history row) for every non-zero variance — that persistence lives in the
 * repository; the variance arithmetic and ledger note live here.
 */
import { DEFAULT_BATCH_KEY } from '@/features/inventory/batches';

/**
 * The key one count line is identified by: an item's lot **at the location being counted**.
 *
 * A single DISCRETE item can hold several lots in one drawer (Phase 28), each audited and
 * reconciled on its own row, so the item id alone does not identify a line. Every producer of a
 * line goes through here — the location's own `stock_batches` read and the auditor's own
 * additions (issue #640) — so a found line and the database line for the same lot are guaranteed
 * to collide on the same key rather than quietly appearing twice.
 */
export function countLineKey(itemId: string, batchKey: string): string {
  return `${itemId}|${batchKey}`;
}

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

/**
 * Compose the ledger note for a serialised instance the auditor **found** in a location the
 * database does not place it in (issue #640):
 * "Serialised audit of Drawer B: Multimeter #3 found here — moved from its recorded location."
 *
 * The counterpart to {@link serialisedAuditNote}. A presence audit that can only record an
 * absence turns every misplacement into a loss: the shelf that should hold the unit reports it
 * missing and retires it, while the shelf that actually holds it has no line to say so. This
 * note is what the other half writes instead — a relocation, not a quantity change.
 */
export function serialisedFoundNote(line: SerialisedAuditLine, locationName: string): string {
  return `Serialised audit of ${locationName}: ${serialisedLabel(line)} found here — moved from its recorded location.`;
}

// --- Found here (issue #640) ----------------------------------------------------
//
// Both halves of the sheet above are built purely from what the database expects to find in the
// location, so a count could record that something is *missing* from where it was expected but
// never that it is *here*. The commonest real cause of a shortfall in a home inventory is that
// the units are one shelf over, and with no way to say so the audit wrote them off: the shelf
// that lost them reconciled to zero, and the shelf that has them had no line to enter.
//
// A **found** entry is the auditor adding an item to the sheet themselves. What it means depends
// on how the item is tracked, so the entry carries that: a DISCRETE item becomes an ordinary
// count line with an expected quantity of zero (any count entered is a surplus at this
// placement), while a SERIALISED instance is a single physical unit that is simply in the wrong
// place — its correction is a relocation, not a quantity change.

/** How the item behind a found entry is tracked — the two modes a count sheet handles. */
export type FoundTrackingMode = 'DISCRETE' | 'SERIALISED';

/** One item the auditor added to a location's sheet because they physically found it there. */
export interface FoundHereEntry {
  readonly itemId: string;
  readonly name: string;
  /** Instance ordinal for a SERIALISED unit; null for a DISCRETE line or an unnumbered unit. */
  readonly serialNo: number | null;
  readonly mode: FoundTrackingMode;
}

/**
 * The found entries still worth showing, given what the location's own sheet already holds.
 *
 * Stock moves while a count is paused, and an audit is exactly the thing that makes it move: an
 * item added here on Monday may genuinely be recorded here by Tuesday, at which point the
 * database's own line is the one to count and a second, expected-zero line beside it would
 * double the sheet's claim about the same shelf. Entries whose line has since appeared are
 * therefore dropped rather than merged.
 *
 * `lineKeys` are the DISCRETE sheet's keys and `instanceIds` the SERIALISED instances already
 * listed; a found DISCRETE entry is keyed by {@link foundLineKey}.
 */
export function usableFound(
  found: readonly FoundHereEntry[],
  lineKeys: ReadonlySet<string>,
  instanceIds: ReadonlySet<string>,
): FoundHereEntry[] {
  const seen = new Set<string>();
  return found.filter((entry) => {
    if (seen.has(entry.itemId)) return false; // one entry per item — adding it twice is one find
    if (entry.mode === 'SERIALISED' ? instanceIds.has(entry.itemId) : lineKeys.has(foundLineKey(entry))) {
      return false;
    }
    seen.add(entry.itemId);
    return true;
  });
}

/**
 * The count-line key a found DISCRETE entry occupies — the item's **untracked** lot at this
 * placement, which is the only lot an auditor looking at unlabelled stock can honestly name.
 * Built through {@link countLineKey}, the same function the database's own lines are keyed by,
 * so the two cannot drift into keying the same lot differently.
 */
export function foundLineKey(entry: { readonly itemId: string }): string {
  return countLineKey(entry.itemId, DEFAULT_BATCH_KEY);
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
