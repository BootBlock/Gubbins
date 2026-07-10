/**
 * Pure test / calibration / service records seam (feature-gap G7 — InvenTree-style QA logs).
 *
 * A structured pass/fail + reading log per **serialised** unit, beyond the free-form maintenance
 * history (`maintenance.ts`): "insulation resistance — Pass, 12.5 MΩ", "annual calibration —
 * Marginal, 0.4 % drift", "warranty service — Pass". Where a maintenance *schedule* answers "when
 * is this due next", a test record answers "what happened, and did it pass" for one specific unit —
 * the audit trail a lab / maker / calibration house keeps against a serial number.
 *
 * This module owns the record vocabulary (result + kind) and *all* of the non-trivial logic —
 * normalisation, the write-validation choke-point, the display sort and the summary aggregation —
 * and nothing else: no React, no repository, no SQL, no DOM. That keeps it exhaustively
 * unit-testable in isolation, the same "logic out of glue" seam as `valuation.ts` /
 * `item-relations.ts` / `wishlist.ts`.
 *
 * ## Closed vocabularies are app-enforced (free TEXT, no DB CHECK)
 *
 * Both `result` and `kind` are small closed vocabularies stored verbatim as free TEXT with **no DB
 * CHECK** — enforced here by {@link normaliseTestResult} / {@link normaliseTestRecordKind}, exactly
 * like `item_relations.kind` / `wishlist.priority` / `item_history.action`. So a future result or
 * kind added by a newer peer syncs forward without a schema change and without a rejected INSERT;
 * a value the running build doesn't recognise softens to a safe default rather than leaking out
 * untyped or crashing the log.
 */

/**
 * The result vocabulary (SSOT). Stored verbatim in `test_records.result` (free TEXT, app-enforced).
 *
 *  - `PASS`  — met the acceptance criteria.
 *  - `FAIL`  — did not meet them.
 *  - `LIMIT` — marginal: within limits but flagged (borderline / conditional).
 *  - `NA`    — no pass/fail judgement (an informational reading, e.g. a bare calibration measurement).
 */
export const TEST_RESULTS = ['PASS', 'FAIL', 'LIMIT', 'NA'] as const;

export type TestResult = (typeof TEST_RESULTS)[number];

/** The result a record takes when none is chosen (and the soft fallback for an unknown value). */
export const DEFAULT_TEST_RESULT: TestResult = 'PASS';

/** Human labels for each result. */
export const TEST_RESULT_LABELS: Record<TestResult, string> = {
  PASS: 'Pass',
  FAIL: 'Fail',
  LIMIT: 'Marginal',
  NA: 'No verdict',
};

/**
 * Semantic tone per result — a gain (pass), a failure, a warning (marginal) or neutral. Kept as an
 * abstract tone rather than a colour so the seam stays free of design tokens / CSS; the UI maps the
 * tone to `text-glyph-*` / status tokens (mirrors `history-format.ts`'s `HistoryTone`).
 */
export type TestResultTone = 'positive' | 'negative' | 'warning' | 'neutral';

export const TEST_RESULT_TONE: Record<TestResult, TestResultTone> = {
  PASS: 'positive',
  FAIL: 'negative',
  LIMIT: 'warning',
  NA: 'neutral',
};

/** Options for the result `Select`, in vocabulary order. */
export const TEST_RESULT_OPTIONS: readonly { readonly value: TestResult; readonly label: string }[] =
  TEST_RESULTS.map((result) => ({ value: result, label: TEST_RESULT_LABELS[result] }));

/** Type guard: is `value` one of the known results? */
export function isTestResult(value: unknown): value is TestResult {
  return typeof value === 'string' && (TEST_RESULTS as readonly string[]).includes(value);
}

/**
 * Coerce arbitrary text to a known {@link TestResult}, falling back to {@link DEFAULT_TEST_RESULT}.
 * Trims + upper-cases so casing/whitespace from an import or a stale peer row is forgiving; anything
 * unrecognised (or absent) softens to the default rather than throwing — a result is a soft hint,
 * never a reason to reject a write or crash a read.
 */
export function normaliseTestResult(raw: string | null | undefined): TestResult {
  if (raw == null) return DEFAULT_TEST_RESULT;
  const key = raw.trim().toUpperCase();
  return isTestResult(key) ? key : DEFAULT_TEST_RESULT;
}

/**
 * The record-kind vocabulary (SSOT). Stored verbatim in `test_records.kind` (free TEXT,
 * app-enforced).
 *
 *  - `TEST`        — a functional / acceptance check.
 *  - `CALIBRATION` — a calibration against a reference.
 *  - `SERVICE`     — a service / maintenance visit recorded against the unit.
 */
export const TEST_RECORD_KINDS = ['TEST', 'CALIBRATION', 'SERVICE'] as const;

export type TestRecordKind = (typeof TEST_RECORD_KINDS)[number];

/** The kind a record takes when none is chosen (and the soft fallback for an unknown value). */
export const DEFAULT_TEST_RECORD_KIND: TestRecordKind = 'TEST';

/** Human labels for each kind. */
export const TEST_RECORD_KIND_LABELS: Record<TestRecordKind, string> = {
  TEST: 'Test',
  CALIBRATION: 'Calibration',
  SERVICE: 'Service',
};

/** Options for the kind `Select`, in vocabulary order. */
export const TEST_RECORD_KIND_OPTIONS: readonly { readonly value: TestRecordKind; readonly label: string }[] =
  TEST_RECORD_KINDS.map((kind) => ({ value: kind, label: TEST_RECORD_KIND_LABELS[kind] }));

/** Type guard: is `value` one of the known kinds? */
export function isTestRecordKind(value: unknown): value is TestRecordKind {
  return typeof value === 'string' && (TEST_RECORD_KINDS as readonly string[]).includes(value);
}

/**
 * Coerce arbitrary text to a known {@link TestRecordKind}, falling back to
 * {@link DEFAULT_TEST_RECORD_KIND}. Forgiving of casing/whitespace; unknown/absent softens to the
 * default (like {@link normaliseTestResult}).
 */
export function normaliseTestRecordKind(raw: string | null | undefined): TestRecordKind {
  if (raw == null) return DEFAULT_TEST_RECORD_KIND;
  const key = raw.trim().toUpperCase();
  return isTestRecordKind(key) ? key : DEFAULT_TEST_RECORD_KIND;
}

/** Trim a required name to its canonical form, or `null` when it is blank. */
export function normaliseTestName(raw: string | null | undefined): string | null {
  const trimmed = raw?.trim();
  return trimmed ? trimmed : null;
}

/** Trim an optional free-text field (unit / note) to its canonical form, or `null` when blank. */
export function normaliseTestText(raw: string | null | undefined): string | null {
  const trimmed = raw?.trim();
  return trimmed ? trimmed : null;
}

/**
 * Normalise an optional numeric reading: `null` (no reading), `undefined` (a value was supplied but
 * is not a finite number — e.g. a fat-fingered `1.2.3`) or the number itself. A reading may be
 * **negative** (temperature, dBm, drift), so — unlike a price — no non-negative constraint applies.
 * Distinguishing `undefined` lets {@link planTestRecord} surface a helpful error rather than
 * silently dropping a bad figure.
 */
export function normaliseReading(raw: number | null | undefined): number | null | undefined {
  if (raw == null) return null;
  if (!Number.isFinite(raw)) return undefined; // supplied but invalid
  return raw;
}

/** A validated, ready-to-persist test record (the content a record write persists). */
export interface NormalisedTestRecord {
  readonly kind: TestRecordKind;
  readonly name: string;
  readonly result: TestResult;
  readonly reading: number | null;
  readonly unit: string | null;
  readonly note: string | null;
}

/** Raw create input, before validation/normalisation. */
export interface TestRecordDraft {
  readonly kind?: string | null;
  readonly name: string;
  readonly result?: string | null;
  readonly reading?: number | null;
  readonly unit?: string | null;
  readonly note?: string | null;
}

/** Why a proposed test record was rejected (see {@link planTestRecord}). */
export type TestRecordPlanError = 'EMPTY_NAME' | 'INVALID_READING';

export type TestRecordPlan =
  | { readonly ok: true; readonly record: NormalisedTestRecord }
  | { readonly ok: false; readonly reason: TestRecordPlanError };

/**
 * Validate + normalise a proposed test record — the single choke-point every write goes through, so
 * the invariants live in one tested place. A blank name is rejected; a supplied but non-finite
 * reading is rejected with a specific reason; an unknown kind/result softens to its default. On
 * success the returned {@link NormalisedTestRecord} is trimmed and safe to persist verbatim.
 *
 * A unit with **no reading** is dropped (a unit describes a measurement — "MΩ" with nothing
 * measured is noise), so `unit` is only kept when a `reading` survives.
 */
export function planTestRecord(draft: TestRecordDraft): TestRecordPlan {
  const name = normaliseTestName(draft.name);
  if (name === null) return { ok: false, reason: 'EMPTY_NAME' };

  const reading = normaliseReading(draft.reading);
  if (reading === undefined) return { ok: false, reason: 'INVALID_READING' };

  // A unit only means something alongside a measurement; drop it when there is no reading.
  const unit = reading === null ? null : normaliseTestText(draft.unit);

  return {
    ok: true,
    record: {
      kind: normaliseTestRecordKind(draft.kind),
      name,
      result: normaliseTestResult(draft.result),
      reading,
      unit,
      note: normaliseTestText(draft.note),
    },
  };
}

/** The minimal shape {@link sortTestRecords} orders by (a superset of a stored row). */
export interface SortableTestRecord {
  readonly id: string;
  /** Effective date of the record (UNIX-ms). */
  readonly performedAt: number;
  readonly createdAt: number;
}

/**
 * Deterministically order records for display, **newest first**: by `performedAt` descending, then
 * `createdAt` descending (a stable tie-break for records sharing a date), then `id` so the order is
 * total and stable across devices. Pure + total, so the repository's SQL ordering and the UI agree
 * and can be asserted equivalent.
 */
export function sortTestRecords<T extends SortableTestRecord>(entries: readonly T[]): T[] {
  return [...entries].sort(
    (a, b) => b.performedAt - a.performedAt || b.createdAt - a.createdAt || a.id.localeCompare(b.id),
  );
}

/** A summary of an item's test records for the section header. */
export interface TestRecordsSummary {
  /** Total number of records. */
  readonly count: number;
  /** Count of records per result. */
  readonly byResult: Record<TestResult, number>;
  /** Count of records per kind. */
  readonly byKind: Record<TestRecordKind, number>;
  /** How many records failed (a quick "needs attention" signal). */
  readonly failCount: number;
  /** The result of the most recent record (by {@link sortTestRecords}), or null when there are none. */
  readonly latestResult: TestResult | null;
}

/** The minimal shape {@link summariseTestRecords} aggregates over. */
export type SummarisableTestRecord = SortableTestRecord & {
  readonly result: TestResult;
  readonly kind: TestRecordKind;
};

/** Build a zeroed `Record<K, number>` tally from a vocabulary. */
function zeroTally<K extends string>(keys: readonly K[]): Record<K, number> {
  return keys.reduce(
    (acc, key) => {
      acc[key] = 0;
      return acc;
    },
    {} as Record<K, number>,
  );
}

/**
 * Aggregate an item's test records into a {@link TestRecordsSummary} — total, per-result and
 * per-kind tallies, the fail count and the most-recent result. The "latest" is resolved through
 * {@link sortTestRecords} so it agrees with the displayed order (deterministic on ties).
 */
export function summariseTestRecords(entries: readonly SummarisableTestRecord[]): TestRecordsSummary {
  const byResult = zeroTally(TEST_RESULTS);
  const byKind = zeroTally(TEST_RECORD_KINDS);

  for (const entry of entries) {
    byResult[entry.result] += 1;
    byKind[entry.kind] += 1;
  }

  const latest = sortTestRecords(entries)[0] ?? null;

  return {
    count: entries.length,
    byResult,
    byKind,
    failCount: byResult.FAIL,
    latestResult: latest?.result ?? null,
  };
}
