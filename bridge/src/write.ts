/**
 * Opt-in **limited writes** (Deferred-work: Read + limited writes).
 *
 * The bridge is read-only by default and stays that way unless the operator explicitly opts
 * in (`GUBBINS_BRIDGE_ALLOW_WRITES=on`). When enabled, a tiny, fixed set of stock mutations
 * becomes available over the HTTP API. The hard constraint that shaped the read-only-first
 * design is **correctness under sync**: the bridge does *not* own the database — the PWA does,
 * via the Phase 7 FS-Access sync and the §7.3 LWW / Delta-CRDT merge. So a write here is **not**
 * a bespoke `UPDATE` on the served snapshot (the next sync would silently overwrite it, or
 * worse, cause drift). Instead the bridge behaves as **just another sync device**:
 *
 *   1. read the latest `gubbins-sync.json` fresh from disk;
 *   2. {@link hydrateFromJson hydrate} it into a private `node:sqlite` DB — the *same* headless
 *      DB the reader uses, with the full production schema, triggers and repositories;
 *   3. apply the mutation through the app's **own** {@link ItemRepository} method
 *      (`adjustQuantity` / `adjustGauge`) — firing the identical recompute + `updated_at`
 *      triggers and appending the same `item_history` ledger row the PWA writes on a local edit;
 *   4. serialise the whole merged state back via {@link buildLocalSnapshot} and write it
 *      **atomically** (temp file + rename) to the same `gubbins-sync.json`.
 *
 * The PWA then picks the change up on its next sync through the **identical** reconcile path it
 * uses for any peer: a bumped `updated_at` wins LWW (REMOTE_WINS), and a gauge change replays
 * through the §7.3 Delta-CRDT from the appended `net_value_delta` row — so there is no drift and
 * no forked merge logic. No SQL is string-built; the only SQL is the parameterised statements
 * the repositories already issue.
 *
 * The module is split so the mutation core ({@link applyOperation}) is pure-ish and unit-tested
 * directly over a hydrated fixture, while {@link executeWrite} is the thin file-IO orchestrator
 * with injectable IO for tests.
 */
import { readFile } from 'node:fs/promises';
import { ItemRepository } from '@/db/repositories/ItemRepository.ts';
import { DbError } from '@/db/errors';
import type { Item } from '@/db/repositories/types';
import type { IDatabaseDriver } from '@/db/rpc/driver';
import { buildLocalSnapshot } from '@/features/sync/snapshot';
import { snapshotToBackupJson } from '@/features/sync/backup';
import { createSnapshotMutex, writeSnapshotAtomic, type SnapshotMutex } from './snapshot-io.ts';
import { hydrateFromJson } from './hydrate.ts';
import { loadItemDetail } from './item-detail.ts';
import type { ItemDetailDto } from './api/dto.ts';
import type { ApiErrorCode } from './api/respond.ts';

/** A note's hard upper bound, so a write can't smuggle an unbounded string into the ledger. */
export const MAX_NOTE_LENGTH = 500;

/**
 * The minimal, fixed set of mutating operations (YAGNI). `adjust-quantity` is a signed delta on
 * a DISCRETE item's home-location stock (check-in `+N` / check-out `-N`); `adjust-gauge` is a
 * signed delta on a CONSUMABLE_GAUGE item's net value. Both map 1:1 to an existing app
 * repository method — nothing else is exposed.
 */
export type WriteOperation =
  | {
      readonly kind: 'adjust-quantity';
      readonly itemId: string;
      readonly delta: number;
      readonly note?: string;
    }
  | {
      readonly kind: 'adjust-gauge';
      readonly itemId: string;
      readonly delta: number;
      readonly note?: string;
    };

/**
 * A write failure carrying the HTTP status + v1 error code the transport should surface. Domain
 * rejections from the repositories (negative quantity, wrong tracking mode) become a `422`
 * `unprocessable` with the repository's own safe message; a missing item a `404`; a snapshot the
 * bridge couldn't read/parse a `503`. Anything else propagates and collapses to a generic 500.
 *
 * (Explicit field assignment — Node's strip-only TypeScript mode rejects constructor *parameter
 * properties*, which `tsc` would otherwise accept.)
 */
export class WriteError extends Error {
  override readonly name = 'WriteError';
  readonly status: number;
  readonly code: ApiErrorCode;
  constructor(status: number, code: ApiErrorCode, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

/**
 * Apply one operation to a hydrated driver via the app's own repository methods. Pure-ish (no
 * file IO) so it is unit-tested directly over the synthetic fixture. Throws a {@link WriteError}
 * on a missing item or a domain rejection; the recompute/`updated_at`/ledger writes are exactly
 * the app's, so the resulting snapshot is LWW/Delta-CRDT-correct by construction.
 */
export async function applyOperation(
  driver: IDatabaseDriver,
  op: WriteOperation,
  actorUserId: string,
): Promise<Item> {
  // Enforce the note bound here, in the shared core, so every surface that mutates through this
  // function honours it — rather than each transport re-checking it (and one of them forgetting).
  if (op.note !== undefined && op.note.length > MAX_NOTE_LENGTH) {
    throw new WriteError(422, 'unprocessable', `A note may be at most ${MAX_NOTE_LENGTH} characters.`);
  }

  // Every ledger row is attributed to the owner of the API token that authorised the request
  // (issue #79, plan §1.3) — the actor is a required argument precisely so this cannot silently
  // fall back to System, as it did while the bridge had only a shared token to go on.
  //
  // The authority is deliberately left unrestricted here: the server has already checked, before
  // routing, that this user's role permits the route. Re-resolving it against the private
  // write-time driver would ask the same question twice of a *second* hydration of the snapshot,
  // and a repository guard tripping mid-write would surface as an opaque 500 rather than the 403
  // the caller should have had.
  const items = new ItemRepository(driver, { resolveActor: () => actorUserId });

  // Explicit existence check first, so a missing item is a clean 404 rather than the
  // repository's generic SQLITE_CONSTRAINT ("Item … does not exist."), which it raises for
  // many other reasons too.
  if ((await items.getById(op.itemId)) === undefined) {
    throw new WriteError(404, 'not_found', 'No such item.');
  }

  try {
    switch (op.kind) {
      case 'adjust-quantity':
        return await items.adjustQuantity(op.itemId, op.delta, op.note);
      case 'adjust-gauge':
        return await items.adjustGauge(op.itemId, { delta: op.delta, note: op.note });
    }
  } catch (err) {
    throw toWriteError(err);
  }
}

/** Map a repository error to a {@link WriteError}, or rethrow so it becomes a generic 500. */
function toWriteError(err: unknown): unknown {
  if (
    err instanceof DbError &&
    (err.code === 'SQLITE_CONSTRAINT' || err.code === 'SQLITE_CONSTRAINT_FOREIGNKEY')
  ) {
    // These messages are safe domain text (e.g. "Quantity cannot fall below zero.") — no SQL,
    // paths, or PII — so they are surfaced to help the caller correct the request.
    return new WriteError(422, 'unprocessable', err.message);
  }
  return err;
}

/** Injectable IO seam so {@link executeWrite} is testable without touching the real filesystem. */
export interface WriteIo {
  readSnapshot(snapshotPath: string): Promise<string>;
  writeSnapshotAtomic(snapshotPath: string, text: string): Promise<void>;
  now(): number;
}

const defaultIo: WriteIo = {
  readSnapshot: (p) => readFile(p, 'utf8'),
  writeSnapshotAtomic,
  now: () => Date.now(),
};

export interface ExecuteWriteOptions {
  readonly snapshotPath: string;
  readonly op: WriteOperation;
  /** The id of the user whose token authorised the write; the actor the ledger records. */
  readonly actorUserId: string;
  /** Override any IO method (tests inject an in-memory file). */
  readonly io?: Partial<WriteIo>;
}

/**
 * Perform one write end-to-end: read the snapshot fresh, hydrate, apply the mutation, then
 * write the merged snapshot back atomically. Returns the updated item's detail (the same
 * {@link ItemDetailDto} the read API returns) for the response. A read/parse failure surfaces as
 * a `503` (the snapshot is briefly unavailable / mid-write) rather than leaking internals.
 */
export async function executeWrite(options: ExecuteWriteOptions): Promise<ItemDetailDto> {
  const io: WriteIo = { ...defaultIo, ...options.io };

  let text: string;
  try {
    text = await io.readSnapshot(options.snapshotPath);
  } catch {
    throw new WriteError(503, 'snapshot_unavailable', 'The inventory snapshot is unavailable.');
  }

  let driver: IDatabaseDriver;
  try {
    ({ driver } = await hydrateFromJson(text));
  } catch {
    throw new WriteError(503, 'snapshot_unavailable', 'The inventory snapshot could not be read.');
  }

  try {
    await applyOperation(driver, options.op, options.actorUserId);
    const detail = await loadItemDetail(driver, options.op.itemId);
    // The item was present a moment ago (applyOperation checked); guard defensively anyway.
    if (detail === null) throw new WriteError(404, 'not_found', 'No such item.');

    const snapshot = await buildLocalSnapshot(driver, io.now());
    await io.writeSnapshotAtomic(options.snapshotPath, snapshotToBackupJson(snapshot));
    return detail;
  } finally {
    await safeClose(driver);
  }
}

/**
 * Build a single-flight write executor bound to one snapshot path. Writes are **serialised**
 * through a shared {@link SnapshotMutex}: each waits for the previous mutation to settle before it
 * reads the file, so two concurrent writes can't both read the pre-write state and clobber each
 * other (a lost update). The mutex is shared with the push-ingest surface at the composition root,
 * so a write and a snapshot push likewise apply one-at-a-time rather than racing on the same file;
 * left to its own default each executor still serialises its own writes.
 */
export function createWriteExecutor(
  snapshotPath: string,
  io?: Partial<WriteIo>,
  mutex: SnapshotMutex = createSnapshotMutex(),
): (op: WriteOperation, actorUserId: string) => Promise<ItemDetailDto> {
  return (op, actorUserId) => mutex.runExclusive(() => executeWrite({ snapshotPath, op, actorUserId, io }));
}

async function safeClose(driver: IDatabaseDriver): Promise<void> {
  try {
    await driver.close();
  } catch {
    // The write driver is discarded after each call; a failed close must not mask the result.
  }
}
