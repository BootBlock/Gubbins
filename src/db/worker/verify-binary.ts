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
 */
import { loadSqlite3 } from './sqlite-bootstrap';
import type { VerifyBinaryResult } from '../rpc/protocol';

/**
 * How many `integrity_check` rows to ask for. The pragma reports one row per problem (up to
 * this many) and a single `ok` row when clean — a thoroughly corrupt file can otherwise
 * produce thousands, none of which change the answer the user needs.
 */
const MAX_PROBLEMS = 20;

/** Run `PRAGMA integrity_check` over `bytes` without touching the live database. */
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
    return { ok: problems.length === 0, problems };
  } catch (err) {
    // A file SQLite cannot even open is as damaged as one that fails the pragma; report it
    // the same way rather than throwing, so the caller has one shape to reason about.
    return { ok: false, problems: [messageOf(err)] };
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
 * Best-effort removal of the temporary in-memory file. The WASM file system is not part of
 * sqlite-wasm's supported surface, so this is probed rather than assumed; failing to reclaim
 * it merely holds the bytes until the page unloads (a restore reloads moments later anyway).
 */
function unlink(sqlite3: Awaited<ReturnType<typeof loadSqlite3>>, path: string): void {
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
