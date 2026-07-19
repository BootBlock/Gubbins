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
 * 2. `PRAGMA integrity_check` in the database worker, over the candidate bytes only.
 *
 * Step 2 is **best-effort**: it needs a worker, and a worker that will not start is a real
 * possibility on the screen this runs from. A verification that cannot be performed reports
 * `unverified` rather than blocking — Safe Mode must never become a dead end — and the
 * downloadable restore point taken before the overwrite is what makes that safe.
 */
import { WorkerDatabaseDriver } from './rpc/worker-driver';
import { inspectSqliteHeader, type SqliteHeaderReport } from './sqlite-header';
import type { VerifyBinaryResult } from './rpc/protocol';

/**
 * - `ok` — the file is a structurally sound database that passes `integrity_check`.
 * - `damaged` — a definite problem was found; restoring it risks losing the current data
 *   for nothing.
 * - `unverified` — the header is sound but the deep check could not run.
 */
export type RestoreCandidateStatus = 'ok' | 'damaged' | 'unverified';

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
 */
export function assessRestoreCandidate(
  header: SqliteHeaderReport,
  verify: VerifyBinaryResult | null,
): RestoreCandidateAssessment {
  if (!header.ok) {
    return { status: 'damaged', problems: header.problems.slice(0, MAX_SHOWN_PROBLEMS) };
  }
  if (verify === null) return { status: 'unverified', problems: [] };
  if (!verify.ok) {
    return { status: 'damaged', problems: verify.problems.slice(0, MAX_SHOWN_PROBLEMS) };
  }
  return { status: 'ok', problems: [] };
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
  if (!header.ok) return assessRestoreCandidate(header, null);

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
  return assessRestoreCandidate(header, verify);
}
