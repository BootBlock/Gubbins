/**
 * Integrity verification of a *candidate* database file (issue #198).
 *
 * A raw `.sqlite` or full-archive restore overwrites the live database and reloads — if the
 * incoming bytes turn out to be corrupt, the original is already gone. The header check
 * (`inspectSqliteHeader`) catches truncation arithmetically, but only SQLite itself can tell
 * whether the b-tree pages behind that header actually hold a readable database. This runs
 * the same `PRAGMA integrity_check` the Maintenance screen offers, against the uploaded bytes,
 * *before* anything is written.
 *
 * The candidate is materialised in the WASM module's own in-memory file system and opened
 * read-only, so the live OPFS database is never opened, locked or touched. Deliberately does
 * not go through {@link bootstrapDatabase}: the live database may be unopenable — that is the
 * state Safe Mode exists for — and a verification that needs it would be unavailable exactly
 * when it is needed most.
 *
 * Since it has the candidate open anyway, it also reads *which schema built it* (issue #501) —
 * `PRAGMA user_version` and the `app_meta` baseline stamp — so a caller can refuse a database
 * that is structurally sound but that this build could not boot.
 */
import { loadSqlite3 } from './sqlite-bootstrap';
import { BASELINE_REVISION_KEY, MISSING_SCHEMA_MARKERS } from '../migrations/migration';
import type { CandidateSchemaIdentity, VerifyBinaryResult } from '../rpc/protocol';

/**
 * How many `integrity_check` rows to ask for. The pragma reports one row per problem (up to
 * this many) and a single `ok` row when clean — a thoroughly corrupt file can otherwise
 * produce thousands, none of which change the answer the user needs.
 */
const MAX_PROBLEMS = 20;

/** The loaded WASM module, and a connection opened from it — named so helpers can be top-level. */
type Sqlite3 = Awaited<ReturnType<typeof loadSqlite3>>;
type CandidateDb = InstanceType<Sqlite3['oo1']['DB']>;

/**
 * Run `PRAGMA integrity_check` over `bytes`, and read which schema built them, without touching
 * the live database.
 */
export async function verifySqliteBinary(bytes: Uint8Array): Promise<VerifyBinaryResult> {
  const sqlite3 = await loadSqlite3();
  // A unique name per call: a previous verification's file may still be resident, and
  // re-creating an open path would verify the wrong bytes.
  const path = `/gubbins-verify-${crypto.randomUUID()}.sqlite3`;
  sqlite3.capi.sqlite3_js_posix_create_file(path, bytes);

  let db: InstanceType<typeof sqlite3.oo1.DB> | null = null;
  try {
    // 'r' — read-only. Verification must never write to the candidate, so a file the user
    // may still want to salvage in another tool comes back exactly as it went in.
    db = new sqlite3.oo1.DB(path, 'r');
    const rows = db.selectValues(`PRAGMA integrity_check(${MAX_PROBLEMS});`) as unknown[];
    const problems = rows
      .map((row) => String(row))
      .filter((message) => message.length > 0 && message !== 'ok');
    return { ok: problems.length === 0, problems, schema: readSchemaIdentity(db) };
  } catch (err) {
    // A file SQLite cannot even open is as damaged as one that fails the pragma; report it
    // the same way rather than throwing, so the caller has one shape to reason about.
    return { ok: false, problems: [messageOf(err)], schema: null };
  } finally {
    try {
      db?.close();
    } catch {
      // Already closed by the failing open — nothing to release.
    }
    unlink(sqlite3, path);
  }
}

/**
 * Read which schema built the candidate (issue #501), or `null` where that could not be
 * established.
 *
 * `null` is deliberately *not* folded into "unstamped": a caller refuses an unstamped database,
 * so a read that merely failed must not be able to masquerade as one. This runs after
 * `integrity_check` on a database SQLite has already opened, so the only expected failure is the
 * absent `app_meta` — everything else means we cannot say, and the caller should not pretend
 * otherwise.
 */
function readSchemaIdentity(db: CandidateDb): CandidateSchemaIdentity | null {
  let userVersion: number;
  try {
    userVersion = Number(db.selectValue('PRAGMA user_version;') ?? 0);
  } catch {
    return null;
  }

  try {
    const stamp = db.selectValue('SELECT value FROM app_meta WHERE key = ?;', [BASELINE_REVISION_KEY]);
    return { userVersion, baselineRevision: stamp == null ? null : String(stamp) };
  } catch (err) {
    // An absent `app_meta` (or an absent column in an ancient one) *is* the answer: unstamped.
    if (isMissingSchemaError(err)) return { userVersion, baselineRevision: null };
    return null;
  }
}

/**
 * True when `err` reports an absent table or column rather than a failure to read at all.
 *
 * The message test only, unlike the boot-time twin in `migrations/engine.ts`, which additionally
 * screens on a `DbError` result code: these errors come straight from `sqlite3.oo1` on a connection
 * this module opened itself, so there is no transport or worker-timeout failure in the population
 * to be talked into looking like a stale schema. The *vocabulary* is shared, so the two cannot
 * drift on what "missing" means.
 */
function isMissingSchemaError(err: unknown): boolean {
  const message = (err instanceof Error ? err.message : String(err)).toLowerCase();
  return MISSING_SCHEMA_MARKERS.some((marker) => message.includes(marker));
}

/**
 * Best-effort removal of the temporary in-memory file. The WASM file system is not part of
 * sqlite-wasm's supported surface, so this is probed rather than assumed; failing to reclaim
 * it merely holds the bytes until the page unloads (a restore reloads moments later anyway).
 */
function unlink(sqlite3: Sqlite3, path: string): void {
  try {
    const fs = (sqlite3.wasm as unknown as { FS?: { unlink?: (p: string) => void } }).FS;
    fs?.unlink?.(path);
  } catch {
    // Not available in this build — the file is transient either way.
  }
}

function messageOf(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  return message.trim().length > 0 ? message : 'SQLite could not open the file.';
}
