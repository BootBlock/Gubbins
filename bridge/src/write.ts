/**
 * Opt-in **limited writes** (Deferred-work: Read + limited writes).
 *
 * The bridge is read-only by default and stays that way unless the operator explicitly opts
 * in (`GUBBINS_BRIDGE_ALLOW_WRITES=on`). When enabled, a small, fixed set of stock and loan
 * mutations becomes available over the HTTP API. The hard constraint that shaped the read-only-first
 * design is **correctness under sync**: the bridge does *not* own the database — the PWA does,
 * via the Phase 7 FS-Access sync and the §7.3 LWW / Delta-CRDT merge. So a write here is **not**
 * a bespoke `UPDATE` on the served snapshot (the next sync would silently overwrite it, or
 * worse, cause drift). Instead the bridge behaves as **just another sync device**:
 *
 *   1. read the latest `gubbins-sync.json` fresh from disk;
 *   2. {@link hydrateFromJson hydrate} it into a private `node:sqlite` DB — the *same* headless
 *      DB the reader uses, with the full production schema, triggers and repositories;
 *   3. apply the mutation through the app's **own** repository method (`ItemRepository`'s
 *      `adjustQuantity` / `adjustGauge` / `transferStock`, or `CheckoutRepository`'s
 *      `checkout` / `checkIn`) — firing the identical recompute + `updated_at` triggers and
 *      appending the same `item_history` ledger row the PWA writes on a local edit;
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
import { CheckoutRepository } from '@/db/repositories/CheckoutRepository.ts';
import { DbError } from '@/db/errors';
import type { Checkout, Item } from '@/db/repositories/types';
import type { IDatabaseDriver } from '@/db/rpc/driver';
import { buildLocalSnapshot } from '@/features/sync/snapshot';
import { snapshotToBackupJson } from '@/features/sync/backup';
import { fromDueDateInputValue, toDueDateInputValue } from '@/lib/date-input';
import { createSnapshotMutex, writeSnapshotAtomic, type SnapshotMutex } from './snapshot-io.ts';
import { hydrateFromJson } from './hydrate.ts';
import { loadItemDetail } from './item-detail.ts';
import { toCheckout, type CheckoutDto, type ItemDetailDto } from './api/dto.ts';
import type { ApiErrorCode } from './api/respond.ts';

/** A note's hard upper bound, so a write can't smuggle an unbounded string into the ledger. */
export const MAX_NOTE_LENGTH = 500;

/**
 * The fixed set of mutating operations (YAGNI — each one earns its place by closing a gap the
 * read side already exposes). Every one maps 1:1 to an existing app repository method; nothing
 * else is reachable.
 *
 * - `adjust-quantity` — a signed delta on a DISCRETE item's home-location stock.
 * - `adjust-gauge` — a signed delta on a CONSUMABLE_GAUGE item's net value.
 * - `check-out` / `check-in` — lend an item to a borrower and take it back (issue #142). The
 *   read side already publishes open loans and their due-backs through the iCalendar feed, so
 *   an automation could be told a loan was overdue but had no way to close it.
 * - `transfer-stock` — move units between two placements. `adjust-quantity` only ever touches
 *   the *home* location, which left the per-location ledger (`item_stock`, the source of truth
 *   for where things are) unreachable from outside the app.
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
    }
  | {
      readonly kind: 'check-out';
      readonly itemId: string;
      /** An existing contact id, or {@link contactName} to resolve-or-create one by name. */
      readonly contactId?: string;
      readonly contactName?: string;
      /** Lend to a project instead (an existing id — never created here). */
      readonly projectId?: string;
      /** Lend to a location instead ("in the van") — an existing id. */
      readonly locationId?: string;
      /** Units to lend; defaults to 1. A serialised item always lends as 1. */
      readonly quantity?: number;
      /**
       * The due date as a plain calendar day (`yyyy-MM-dd`), or null/absent for an open-ended
       * loan. A *date*, not an instant, deliberately: a deadline belongs to the borrower's own
       * day, and {@link fromDueDateInputValue} anchors it at local end-of-day exactly as the app
       * does — so a loan due "the 20th" only reads overdue once the 20th is over.
       */
      readonly dueDate?: string | null;
      /** The placement to lend from; defaults to the item's primary location. */
      readonly fromLocationId?: string;
      readonly note?: string;
    }
  | {
      readonly kind: 'check-in';
      readonly itemId: string;
      /**
       * Which loan to close. Optional: when the item has exactly one open loan it is
       * unambiguous, so a caller that only knows the item can still return it. Required
       * (as a 422) once there is more than one.
       */
      readonly checkoutId?: string;
      readonly note?: string;
    }
  | {
      readonly kind: 'transfer-stock';
      readonly itemId: string;
      readonly fromLocationId: string;
      readonly toLocationId: string;
      readonly quantity: number;
    };

/**
 * What a write produced: the affected item always, plus the loan when the operation was one
 * (`check-out` / `check-in`). The checkout's **id** is the part that matters — it is what a
 * later `check-in` names, and it matches the `UID` the iCalendar feed publishes for that loan.
 */
export interface WriteOutcome {
  readonly item: Item;
  readonly checkout: Checkout | null;
}

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
): Promise<WriteOutcome> {
  // Enforce the note bound here, in the shared core, so every surface that mutates through this
  // function honours it — rather than each transport re-checking it (and one of them forgetting).
  const note = 'note' in op ? op.note : undefined;
  if (note !== undefined && note.length > MAX_NOTE_LENGTH) {
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
  const repositoryOptions = { resolveActor: () => actorUserId };
  const items = new ItemRepository(driver, repositoryOptions);

  // Explicit existence check first, so a missing item is a clean 404 rather than the
  // repository's generic SQLITE_CONSTRAINT ("Item … does not exist."), which it raises for
  // many other reasons too.
  if ((await items.getById(op.itemId)) === undefined) {
    throw new WriteError(404, 'not_found', 'No such item.');
  }

  try {
    switch (op.kind) {
      case 'adjust-quantity':
        return { item: await items.adjustQuantity(op.itemId, op.delta, op.note), checkout: null };
      case 'adjust-gauge':
        return {
          item: await items.adjustGauge(op.itemId, { delta: op.delta, note: op.note }),
          checkout: null,
        };
      case 'check-out':
        return await applyCheckOut(driver, items, op, repositoryOptions);
      case 'check-in':
        return await applyCheckIn(driver, items, op, repositoryOptions);
      case 'transfer-stock':
        return { item: await applyTransfer(items, op), checkout: null };
    }
  } catch (err) {
    throw toWriteError(err);
  }
}

/**
 * Lend units of an item out. Everything about *whether* the loan is allowed — the tracking
 * mode, the borrower target, on-hand availability at the source placement — is the
 * repository's own check, so a rejection carries the app's wording and stays single-sourced;
 * only the due-date *format* is decided here, because it is the transport's convention rather
 * than the domain's.
 */
async function applyCheckOut(
  driver: IDatabaseDriver,
  items: ItemRepository,
  op: Extract<WriteOperation, { kind: 'check-out' }>,
  repositoryOptions: { resolveActor: () => string },
): Promise<WriteOutcome> {
  const checkouts = new CheckoutRepository(driver, repositoryOptions);
  const checkout = await checkouts.checkout({
    itemId: op.itemId,
    ...(op.contactId !== undefined ? { contactId: op.contactId } : {}),
    ...(op.contactName !== undefined ? { contactName: op.contactName } : {}),
    ...(op.projectId !== undefined ? { projectId: op.projectId } : {}),
    ...(op.locationId !== undefined ? { locationId: op.locationId } : {}),
    ...(op.quantity !== undefined ? { quantity: op.quantity } : {}),
    ...(op.fromLocationId !== undefined ? { fromLocationId: op.fromLocationId } : {}),
    dueDate: parseDueDate(op.dueDate),
    ...(op.note !== undefined ? { note: op.note } : {}),
  });
  return { item: (await items.getById(op.itemId))!, checkout };
}

/**
 * Take a loan back. The loan is named by `checkoutId`, or resolved from the item when it has
 * exactly one open loan — the common case, and the one an automation reaching for "that's back
 * now" actually has to hand. More than one open loan is genuinely ambiguous, so it asks rather
 * than guessing which borrower just returned something.
 */
async function applyCheckIn(
  driver: IDatabaseDriver,
  items: ItemRepository,
  op: Extract<WriteOperation, { kind: 'check-in' }>,
  repositoryOptions: { resolveActor: () => string },
): Promise<WriteOutcome> {
  const checkouts = new CheckoutRepository(driver, repositoryOptions);
  const checkoutId = await resolveOpenCheckoutId(checkouts, op);
  const checkout = await checkouts.checkIn(checkoutId, op.note !== undefined ? { note: op.note } : {});
  return { item: (await items.getById(op.itemId))!, checkout };
}

/** Pick the loan a `check-in` closes: the named one, or the item's single open loan. */
async function resolveOpenCheckoutId(
  checkouts: CheckoutRepository,
  op: Extract<WriteOperation, { kind: 'check-in' }>,
): Promise<string> {
  if (op.checkoutId !== undefined) {
    const named = await checkouts.getById(op.checkoutId);
    // Belonging to *this* item is part of the identity check: `/items/{id}/check-in` naming
    // another item's loan is a mistake, not a licence to return that other item.
    if (named === undefined || named.itemId !== op.itemId) {
      throw new WriteError(404, 'not_found', 'No such loan for this item.');
    }
    if (named.returnedAt !== null) {
      throw new WriteError(422, 'unprocessable', 'That loan has already been returned.');
    }
    return named.id;
  }

  // Two rows are enough to tell "none", "exactly one" and "several" apart, and `listForItem`
  // orders open loans first — so the open ones are the rows this page actually contains.
  const page = await checkouts.listForItem(op.itemId, { limit: 2, offset: 0 });
  const open = page.rows.filter((row) => row.status === 'OPEN');
  if (open.length === 0) {
    throw new WriteError(422, 'unprocessable', 'This item is not currently checked out.');
  }
  if (open.length > 1) {
    throw new WriteError(
      422,
      'unprocessable',
      'This item has more than one open loan — name the one to return with "checkoutId".',
    );
  }
  return open[0]!.id;
}

/**
 * Move units between two placements.
 *
 * The availability check is done *here*, up front, rather than left to `transferStock`: that
 * method **clamps** an over-large request to what is on hand (a deliberate choice for the UI,
 * which shows the clamp), and a clamp over an API is a silent partial success — the caller asks
 * to move ten, three move, and the response says 200. An API should move all of it or none, so
 * a shortfall is a 422 here instead.
 */
async function applyTransfer(
  items: ItemRepository,
  op: Extract<WriteOperation, { kind: 'transfer-stock' }>,
): Promise<Item> {
  if (!Number.isInteger(op.quantity) || op.quantity <= 0) {
    throw new WriteError(422, 'unprocessable', 'Transfer quantity must be a positive whole number.');
  }
  const placements = await items.listStock(op.itemId);
  const available = placements.find((p) => p.locationId === op.fromLocationId)?.quantity ?? 0;
  if (available < op.quantity) {
    throw new WriteError(
      422,
      'unprocessable',
      `Not enough stock at the source location to transfer: ${available} available, ${op.quantity} requested.`,
    );
  }
  return await items.transferStock(op.itemId, op.fromLocationId, op.toLocationId, op.quantity);
}

/**
 * Parse a `yyyy-MM-dd` due date into the instant the app stores, or null for an open-ended
 * loan. Anchored at **local end-of-day** by `fromDueDateInputValue` — the app-wide rule for a
 * loan deadline (issue #318), and deliberately not the midnight-UTC convention every other
 * day-grained value uses. Never re-derive it here: a private copy would flag loans overdue a
 * day early west of UTC.
 */
function parseDueDate(value: string | null | undefined): number | null {
  if (value === undefined || value === null) return null;
  const day = value.trim();
  // `Date.parse` is lenient enough to accept "20 July 2026" or a full ISO instant; requiring
  // the exact calendar-day shape keeps one documented format rather than an accidental dialect.
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) {
    throw new WriteError(422, 'unprocessable', 'A due date must be a calendar day in yyyy-MM-dd form.');
  }
  const ms = fromDueDateInputValue(day);
  // A day that does not exist must be refused, not quietly rolled forward: `2026-02-31` parses
  // to 3 March, which would set a due date the caller never asked for. Reading the instant back
  // as a day and comparing catches that, and reuses the very inverse the app relies on rather
  // than re-implementing a calendar. (A date picker cannot produce such a day — an API can.)
  if (ms === null || toDueDateInputValue(ms) !== day) {
    throw new WriteError(422, 'unprocessable', 'That due date is not a real calendar day.');
  }
  return ms;
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
 * What one write returns: the affected item's detail (the same {@link ItemDetailDto} the read
 * API serves) and, for the loan operations, the loan it opened or closed. `checkout` is null
 * for every other operation — a transport decides for itself whether to surface it, so the
 * stock endpoints' shipped response shape is untouched by the loan ones existing.
 */
export interface WriteResult {
  readonly item: ItemDetailDto;
  readonly checkout: CheckoutDto | null;
}

/**
 * Perform one write end-to-end: read the snapshot fresh, hydrate, apply the mutation, then
 * write the merged snapshot back atomically. A read/parse failure surfaces as a `503` (the
 * snapshot is briefly unavailable / mid-write) rather than leaking internals.
 */
export async function executeWrite(options: ExecuteWriteOptions): Promise<WriteResult> {
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
    const outcome = await applyOperation(driver, options.op, options.actorUserId);
    const detail = await loadItemDetail(driver, options.op.itemId);
    // The item was present a moment ago (applyOperation checked); guard defensively anyway.
    if (detail === null) throw new WriteError(404, 'not_found', 'No such item.');

    const snapshot = await buildLocalSnapshot(driver, io.now());
    await io.writeSnapshotAtomic(options.snapshotPath, snapshotToBackupJson(snapshot));
    return { item: detail, checkout: outcome.checkout === null ? null : toCheckout(outcome.checkout) };
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
): (op: WriteOperation, actorUserId: string) => Promise<WriteResult> {
  return (op, actorUserId) => mutex.runExclusive(() => executeWrite({ snapshotPath, op, actorUserId, io }));
}

async function safeClose(driver: IDatabaseDriver): Promise<void> {
  try {
    await driver.close();
  } catch {
    // The write driver is discarded after each call; a failed close must not mask the result.
  }
}
