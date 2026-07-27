/**
 * Pre-flight assessment of a database file about to overwrite the live one (issue #198).
 *
 * Both destructive restores in Safe Mode — a raw `.sqlite` binary and the database inside a
 * full `.zip` archive — used to check nothing but the 16-byte magic string before disposing
 * the worker, overwriting OPFS and reloading. A truncated download or a half-synced cloud
 * file passes that check perfectly, and by the time the failure surfaces the original data is
 * gone. This runs the two checks the app already knows how to make, in cost order:
 *
 * 1. {@link inspectSqliteHeader} — pure, instant, and catches the common truncation case.
 * 2. `PRAGMA integrity_check` in the database worker, over the candidate bytes only — which also
 *    reports **which schema built the candidate** (issue #501).
 *
 * Step 2 is **best-effort**: it needs a worker, and a worker that will not start is a real
 * possibility on the screen this runs from. A verification that cannot be performed reports
 * `unverified` rather than blocking — Safe Mode must never become a dead end — and the
 * downloadable restore point taken before the overwrite is what makes that safe.
 */
import { BASELINE_REVISION, TARGET_SCHEMA_VERSION } from './migrations';
import { WorkerDatabaseDriver } from './rpc/worker-driver';
import { inspectSqliteHeader, type SqliteHeaderReport } from './sqlite-header';
import type { VerifyBinaryResult } from './rpc/protocol';

/**
 * The schema this build can actually open — the two things boot judges a database on before it
 * will serve a single query (issue #501).
 *
 * Passed in rather than imported by the pure verdict below, exactly as `assertBaselineCurrent`
 * takes its `expected`, so the assessment stays independent of any one concrete baseline.
 */
export interface ExpectedSchema {
  /** The baseline fingerprint `assertBaselineCurrent` demands, else `SCHEMA_STALE`. */
  readonly baselineRevision: string;
  /** The highest `user_version` this build has migrations for, else `SCHEMA_TOO_NEW`. */
  readonly schemaVersion: number;
}

/** What this build expects, for the assessment to judge a candidate against. */
const EXPECTED_SCHEMA: ExpectedSchema = {
  baselineRevision: BASELINE_REVISION,
  schemaVersion: TARGET_SCHEMA_VERSION,
};

/**
 * - `ok` — the file is a structurally sound database that passes `integrity_check`, built by the
 *   schema baseline this build expects.
 * - `damaged` — a definite problem was found; restoring it risks losing the current data
 *   for nothing.
 * - `incompatible` — sound, but built by a schema this build cannot open (issue #501). Restoring it
 *   would replace a working database with one refused at the next boot (`SCHEMA_STALE` /
 *   `SCHEMA_TOO_NEW`).
 * - `unverified` — the header is sound but the deep check could not run.
 */
export type RestoreCandidateStatus = 'ok' | 'damaged' | 'incompatible' | 'unverified';

/** What the pre-flight checks concluded about a candidate database file. */
export interface RestoreCandidateAssessment {
  readonly status: RestoreCandidateStatus;
  /** Human-readable problems (empty unless `damaged`), capped for display. */
  readonly problems: readonly string[];
}

/** The most problems worth showing — beyond a handful, the verdict is what matters. */
const MAX_SHOWN_PROBLEMS = 5;

/**
 * Combine a header report with the deep-check outcome into one verdict. Pure — `verify` is
 * `null` when the check could not be run at all.
 *
 * Damage is judged *first*: a file that is falling apart is the more urgent news, and its schema
 * identity cannot be trusted anyway.
 *
 * A candidate whose schema identity could not be read at all (`verify.schema === null`) is not
 * called incompatible — see {@link VerifyBinaryResult.schema}. It passes as before, and the
 * `SCHEMA_STALE` boot screen with its downloadable restore point remains the backstop.
 */
export function assessRestoreCandidate(
  header: SqliteHeaderReport,
  verify: VerifyBinaryResult | null,
  expected: ExpectedSchema,
): RestoreCandidateAssessment {
  if (!header.ok) {
    return { status: 'damaged', problems: header.problems.slice(0, MAX_SHOWN_PROBLEMS) };
  }
  if (verify === null) return { status: 'unverified', problems: [] };
  if (!verify.ok) {
    return { status: 'damaged', problems: verify.problems.slice(0, MAX_SHOWN_PROBLEMS) };
  }
  if (verify.schema !== null && !canOpen(verify.schema, expected)) {
    return { status: 'incompatible', problems: [] };
  }
  return { status: 'ok', problems: [] };
}

/**
 * Whether this build's boot sequence would actually open a database with this identity — the two
 * refusals `runMigrations` and `assertBaselineCurrent` make, asked *before* the overwrite instead
 * of after it.
 *
 * The stamp is compared for **exact equality**: it is a fingerprint, so "different" is the only
 * meaningful relation, and an unstamped database (`null`) is as unbootable as a mismatched one.
 * The version is compared as **ahead-of-this-build** rather than for equality, matching
 * `SCHEMA_TOO_NEW`: a database behind the current version is one the engine migrates forward, which
 * is a restore working as intended. This is not merely a second spelling of the stamp check —
 * appending a forward migration changes the version while leaving the baseline's own DDL, and so
 * its fingerprint, untouched.
 */
function canOpen(schema: NonNullable<VerifyBinaryResult['schema']>, expected: ExpectedSchema): boolean {
  if (schema.baselineRevision !== expected.baselineRevision) return false;
  return schema.userVersion <= expected.schemaVersion;
}

/**
 * Assess `bytes` before they are allowed to overwrite the live database. A header that is
 * already broken short-circuits: SQLite cannot say anything useful about a file whose page
 * geometry does not add up, and spinning up a worker to hear so wastes the user's time on
 * the one screen where time matters.
 *
 * The deep check runs in a **dedicated, throwaway worker** rather than the app's shared
 * driver: the shared one may be disposed or latched-unavailable (the ordinary state in Safe
 * Mode), and this must not open the live OPFS database in any case.
 */
export async function inspectRestoreCandidate(bytes: Uint8Array): Promise<RestoreCandidateAssessment> {
  const header = inspectSqliteHeader(bytes);
  if (!header.ok) return assessRestoreCandidate(header, null, EXPECTED_SCHEMA);

  let driver: WorkerDatabaseDriver | null = null;
  let verify: VerifyBinaryResult | null = null;
  try {
    driver = new WorkerDatabaseDriver();
    verify = await driver.verifyBinary(bytes);
  } catch (error) {
    // Kept for diagnostics; the user-facing consequence is the `unverified` verdict, which
    // warns rather than blocks.
    console.warn('[gubbins] could not verify the restore candidate', error);
  } finally {
    driver?.dispose();
  }
  return assessRestoreCandidate(header, verify, EXPECTED_SCHEMA);
}
