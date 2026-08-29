/**
 * The sync orchestrator (spec §7.2, §7.3, §7.4, Phase 7).
 *
 * Ties the database-bound {@link mergeSnapshot} half to a {@link CloudProvider} and the
 * storage safeguards. The reconciliation logic itself stays pure & tested; everything
 * browser-only (storage estimate, the provider transport) is injected or feature-detected so
 * the whole flow is exercisable on the `:memory:` driver.
 *
 * Normal lifecycle (§7.3): pre-flight quota Hard Stop (§7.4) → server-time offset
 * guard (§7.3.1) → fetch remote → merge (read local, reconcile, apply, re-read) → push the
 * merged snapshot → prune expired tombstones (§7.2 TTL) → stamp `sync_meta`.
 *
 * The merge step is deliberately one coarse call into `./merge`: on a driver that supports it
 * that whole step runs in the database worker, so the full local snapshot and the long
 * synchronous reconcile pass never touch the main thread (issue #173). What stays here is
 * precisely what cannot move — the network transport and the browser storage API.
 *
 * TTL edge (§7.2): a device whose `last_sync_timestamp` predates the 180-day
 * Tombstone TTL cannot trust delta reconciliation (the remote may have pruned the
 * tombstones it needs), so it performs a **Pre-Wipe Salvage** — capture local
 * mutations since the last sync, clone the remote wholesale, then re-apply the
 * salvaged work as local-wins — rather than a blind wipe.
 */
import type { IDatabaseDriver } from '@/db/rpc/driver';
import { estimateStorage } from '@/features/storage/storage-api';
import { STORAGE_THRESHOLDS, isWriteSuspended } from '@/features/storage/tiers';
import { useStorageStore } from '@/state/stores/useStorageStore';
import { labFlag } from '@/state/stores/useLabStore';
import { measureClockOffset } from './clock';
import { TOMBSTONE_TTL_MS } from './retention';
import { mergeSnapshot } from './merge';
import type { CloudProvider } from './provider';
import {
  PUSH_FAILED_MESSAGE,
  REMOTE_MISSING_MESSAGE,
  SyncPushFailedError,
  SyncRemoteMissingError,
} from './sync-errors';
import type { SyncConflict, SyncSnapshot } from './types';

/**
 * §7.2 Tombstone TTL: 180 days in milliseconds.
 *
 * Defined in `./retention` beside the stock-ledger horizon that must never be shorter than it
 * (issue #544), and re-exported here where every caller already looks for it.
 *
 * @internal Exported for unit tests only.
 */
export { TOMBSTONE_TTL_MS };

export interface SyncResult {
  /**
   * `MERGED_NOT_PUBLISHED` is the half-completed pass (issue #638): the remote was pulled and
   * merged into the local database, but uploading the merged snapshot failed. It never comes
   * back as a *return* value — the pass still throws — it is what
   * {@link import('./sync-errors').SyncPushFailedError} carries so the caller can report and
   * adopt the half that did happen.
   */
  readonly status: 'SYNCED' | 'PUBLISHED' | 'CLONED' | 'HARD_STOP' | 'MERGED_NOT_PUBLISHED';
  /** Rows upserted locally from the remote. */
  readonly pulled: number;
  /** Rows deleted locally by winning remote tombstones. */
  readonly deleted: number;
  /** §7.5.2 items automatically re-parented to Unassigned. */
  readonly reparented: number;
  /** §7.5.3 location moves discarded to avoid a cycle. */
  readonly rejectedCycles: number;
  /** Issue #193: serialised items whose surplus open loan the merge closed (double-booked offline). */
  readonly serialisedLoansClosed: number;
  /** Issue #194: bookings the merge cancelled because they double-booked an asset (booked offline on two devices). */
  readonly bookingsCancelled: number;
  /** Issue #539: kit component links the merge removed because they closed a containment loop (nested offline on two devices). */
  readonly kitLinksBroken: number;
  /** Issue #542: loans the merge kept closed against a peer's newer still-open copy (returned offline). */
  readonly loanReturnsPreserved: number;
  /** Loans whose instalment count the merge kept from being rewound (issue #662). */
  readonly loanInstalmentsPreserved: number;
  /** Expired tombstones pruned (§7.2 TTL). */
  readonly prunedTombstones: number;
  /** The clock offset applied (ms, server − local). */
  readonly clockOffset: number;
  /** Phase 11: append-only `item_history` rows unioned in from the remote. */
  readonly historyInserted: number;
  /** Tag membership edges added locally — `item_tags` (Phase 11) + `location_tags` (issue #84). */
  readonly tagEdgesAdded: number;
  /** Tag membership edges removed locally (peer unlinked) — `item_tags` + `location_tags`. */
  readonly tagEdgesRemoved: number;
  /**
   * Issue #72: genuine same-row concurrent-edit collisions where a local edit made since the
   * last sync lost to a remote change/deletion. Empty on the first publish / TTL clone (no
   * prior common state). The UI persists these for review; they are not applied to the DB.
   */
  readonly conflicts: readonly SyncConflict[];
  /** Present when status is HARD_STOP. */
  readonly message?: string;
}

export interface SyncMeta {
  readonly lastSyncTimestamp: number;
  readonly clockOffset: number;
  /** §7.6.3-A prune watermark: don't re-import ledger rows older than this (Phase 11). */
  readonly historyPrunedBefore: number;
}

/**
 * §7.2: must we full-clone rather than delta-reconcile?
 *
 * @internal Exported for unit tests only.
 */
export function needsFullResync(
  lastSyncTimestamp: number,
  serverNow: number,
  ttlMs = TOMBSTONE_TTL_MS,
): boolean {
  if (lastSyncTimestamp <= 0) return false; // never synced — the normal path handles it
  return serverNow - lastSyncTimestamp > ttlMs;
}

async function readSyncMeta(driver: IDatabaseDriver): Promise<SyncMeta> {
  const row = await driver.queryOne<{
    last_sync_timestamp: number;
    clock_offset: number;
    history_pruned_before: number;
  }>('SELECT last_sync_timestamp, clock_offset, history_pruned_before FROM sync_meta WHERE id = 1;');
  return {
    lastSyncTimestamp: Number(row?.last_sync_timestamp ?? 0),
    clockOffset: Number(row?.clock_offset ?? 0),
    historyPrunedBefore: Number(row?.history_pruned_before ?? 0),
  };
}

async function writeSyncMeta(
  driver: IDatabaseDriver,
  lastSyncTimestamp: number,
  clockOffset: number,
): Promise<void> {
  await driver.execute('UPDATE sync_meta SET last_sync_timestamp = ?, clock_offset = ? WHERE id = 1;', [
    lastSyncTimestamp,
    clockOffset,
  ]);
}

export interface RunSyncOptions {
  /** Override the local clock (tests). */
  readonly now?: () => number;
  /**
   * Skip the §7.4 pre-flight quota check (tests / environments without the Storage
   * API). Production leaves this false so a near-full origin triggers the Hard Stop.
   */
  readonly skipQuotaCheck?: boolean;
  /** Override the Tombstone TTL (tests). */
  readonly ttlMs?: number;
  /**
   * §7.3 NTP fallback: an authoritative time source consulted only when the provider has
   * no clock of its own (`getServerTime()` → null, e.g. the File System Access folder).
   * Returns epoch ms or null. Defaults to unused, so callers without a source keep the
   * pre-Phase-14 "trust the local clock" behaviour. The UI wires {@link httpTimeSource}.
   */
  readonly serverTime?: () => Promise<number | null>;
  /**
   * Issue #196: permit a first-publish push even though this device has synced before, i.e.
   * accept that the shared snapshot is gone and republish this device's data as the new one.
   * **Destructive to the shared copy** — the sync screen only sets it after the user has
   * confirmed, never automatically.
   */
  readonly allowRemoteReset?: boolean;
}

/**
 * Run one synchronisation pass against `provider`. Returns a {@link SyncResult};
 * never throws for the expected Hard-Stop case (returns `status: 'HARD_STOP'`).
 *
 * A push that fails *after* the merge committed throws a
 * {@link import('./sync-errors').SyncPushFailedError} rather than the bare transport error, so
 * the caller can still adopt the local half — see that class and {@link pushMerged} (issue #638).
 *
 * **Not gated on `sync:read` / `sync:write`, deliberately** (issue #519). A sync pass is device
 * replication, not an action against the vault: it is how a device *receives* what other devices
 * did — including the role and permission changes themselves — so a session that could not sync
 * would drift away from the very rules meant to bound it, and would go on drifting silently. The
 * `sync:*` keys are enforced where a sync actually crosses a trust boundary: the Bridge holds
 * `POST /api/v1/snapshot` to `sync:write` (see `bridge/src/identity.ts`), and the destructive
 * local paths that used to reach the driver unchecked — the Danger-Zone erase and the backup
 * restore — now assert their own keys.
 *
 * That covers this module's own two direct writes as well (issue #429): the `sync_meta` stamp
 * and the §7.2 TTL tombstone prune. Neither is an edit to the vault — one records when this
 * device last replicated and how far its clock is out, the other discards deletion records the
 * whole network has long since seen. Refusing them while still letting the pass merge would
 * leave the device replicating from a stale watermark for ever and never reclaiming the space,
 * which is a worse outcome than either check was meant to buy. What a *user* chooses to overturn
 * after a merge is a different act, and `./conflict-restore` does assert `sync:write` for it.
 */
export async function runSync(
  driver: IDatabaseDriver,
  provider: CloudProvider,
  options: RunSyncOptions = {},
): Promise<SyncResult> {
  const now = options.now ?? (() => Date.now());
  const ttlMs = options.ttlMs ?? TOMBSTONE_TTL_MS;

  // --- §7.4 pre-flight quota Hard Stop ------------------------------------------
  if (!options.skipQuotaCheck) {
    const estimate = await estimateStorage();
    if (estimate.supported && estimate.ratio >= STORAGE_THRESHOLDS.critical) {
      return hardStop(
        `Storage is ${(estimate.ratio * 100).toFixed(0)}% full — sync aborted to avoid eviction. Free space and retry.`,
      );
    }
    // A write that actually ran out of space outranks that reading (issue #504): a padded quota,
    // an opaque VFS pool or a full device all report exactly the headroom checked above. The
    // reconciliation below is the largest write the app makes, so letting it start on the
    // strength of a figure a write has already disproved is the one thing this gate is for.
    if (isWriteSuspended(useStorageStore.getState().tier)) {
      return hardStop(
        'Storage is full — sync aborted to avoid a merge that cannot finish. Free space and retry.',
      );
    }
  }

  // --- §7.3.1 NTP offset guard --------------------------------------------------
  // Prefer the provider's own server time; fall back to the injected NTP-style source
  // (§7.3 "a lightweight reliable time server *or* the cloud provider's API header").
  // The clock is sampled either side of the round-trip so latency isn't mistaken for skew
  // (see measureClockOffset) — otherwise a slow link mis-resolves LWW by its own latency.
  const { offset, serverNow, localNow } = await measureClockOffset(now, async () => {
    const primary = await provider.getServerTime();
    if (primary !== null) return primary;
    return options.serverTime ? await options.serverTime() : null;
  });
  const effectiveNow = serverNow ?? localNow;

  const rawRemote = await provider.fetchSnapshot();
  const meta = await readSyncMeta(driver);
  // Resolved here, not inside the merge: the lab-flag store is main-thread-only, and the merge
  // may well be running in the database worker (issue #173).
  const forceTies = labFlag('sync-lww-tie');

  // Everything the database-bound half needs that does not depend on which of the three §7.3
  // paths this pass takes. The merge runs in the database worker where the driver supports it
  // (issue #173), so it is handed plain data — the raw server-time remote included; the frame
  // conversions happen there, off the main thread.
  const mergeBase = {
    offset,
    effectiveNow,
    lastSyncTimestamp: meta.lastSyncTimestamp,
    historyPrunedBefore: meta.historyPrunedBefore,
    forceTies,
  } as const;

  // First publish: no remote yet — just push our state, normalised to server time.
  if (rawRemote === null) {
    // Issue #196: "no remote" is only credible when this device has never synced. Once it
    // has, the shared snapshot demonstrably existed, so its absence means it went missing
    // (wrong folder reconnected, file trashed, a cloud drive that hasn't populated) — and
    // publishing over it would replace the shared state with just this device's, discarding
    // everything that only lives on the others. Refuse; the user can confirm a deliberate
    // republish via `allowRemoteReset`.
    if (meta.lastSyncTimestamp > 0 && !options.allowRemoteReset) {
      throw new SyncRemoteMissingError(REMOTE_MISSING_MESSAGE);
    }
    const { merged } = await mergeSnapshot(driver, {
      ...mergeBase,
      mode: 'publish',
      remote: null,
    });
    // Not wrapped as a half-completed pass (#638): `publish` mode only *reads* the local state,
    // so a failed upload here genuinely leaves nothing changed — "sync failed" is the truth.
    await provider.pushSnapshot(merged);
    const pruned = await pruneTombstones(driver, effectiveNow, ttlMs);
    await writeSyncMeta(driver, effectiveNow, offset);
    return result('PUBLISHED', { prunedTombstones: pruned, clockOffset: offset });
  }

  // --- §7.2 TTL edge: full clone with Pre-Wipe Salvage --------------------------
  if (needsFullResync(meta.lastSyncTimestamp, effectiveNow, ttlMs)) {
    const { merged } = await mergeSnapshot(driver, {
      ...mergeBase,
      mode: 'clone',
      remote: rawRemote,
    });
    // The clone has already replaced this device's tables wholesale, so a failed push leaves
    // local state changed — the caller has to know that even though there are no tallies (#638).
    await pushMerged(provider, merged, { clockOffset: offset });
    const pruned = await pruneTombstones(driver, effectiveNow, ttlMs);
    await writeSyncMeta(driver, effectiveNow, offset);
    return result('CLONED', { prunedTombstones: pruned, clockOffset: offset });
  }

  // --- §7.3 normal delta reconciliation -----------------------------------------
  // Issue #72 conflict detection needs the last-sync watermark in the *local* frame:
  // `sync_meta.last_sync_timestamp` is stored in server time (every push normalises to it), so
  // shift it back by the offset to compare against the local-frame row timestamps.
  const conflictSince = meta.lastSyncTimestamp > 0 ? meta.lastSyncTimestamp - offset : undefined;
  const outcome = await mergeSnapshot(driver, {
    ...mergeBase,
    mode: 'delta',
    remote: rawRemote,
    conflictSince,
  });
  // Everything the merge has *already committed* locally, named once so the failed-push path
  // reports exactly what the success path would (issue #638) — the conflicts above all, since
  // they describe local edits that no longer exist to be re-detected on a later pass.
  const applied: Partial<SyncResult> = {
    pulled: outcome.pulled,
    deleted: outcome.deleted,
    reparented: outcome.reparented,
    rejectedCycles: outcome.rejectedCycles,
    serialisedLoansClosed: outcome.serialisedLoansClosed,
    bookingsCancelled: outcome.bookingsCancelled,
    kitLinksBroken: outcome.kitLinksBroken,
    loanReturnsPreserved: outcome.loanReturnsPreserved,
    loanInstalmentsPreserved: outcome.loanInstalmentsPreserved,
    clockOffset: offset,
    historyInserted: outcome.historyInserted,
    tagEdgesAdded: outcome.tagEdgesAdded,
    tagEdgesRemoved: outcome.tagEdgesRemoved,
    conflicts: outcome.conflicts,
  };
  await pushMerged(provider, outcome.merged, applied);
  const pruned = await pruneTombstones(driver, effectiveNow, ttlMs);
  await writeSyncMeta(driver, effectiveNow, offset);

  return result('SYNCED', { ...applied, prunedTombstones: pruned });
}

/**
 * Push the merged snapshot, tagging any failure with what the merge already committed locally.
 *
 * Issue #638: by this point the pull has been applied and re-read, so the local database has
 * changed whether or not the upload lands. Rethrowing as a {@link SyncPushFailedError} is what
 * lets the caller keep the parts that do not depend on the push — the conflict records and a
 * cache refresh — instead of discarding them with an unreturned outcome. `prunedTombstones` is
 * deliberately absent from `applied`: the prune runs *after* the push, so a failed pass really
 * did prune nothing, and the next attempt does it.
 */
async function pushMerged(
  provider: CloudProvider,
  merged: SyncSnapshot,
  applied: Partial<SyncResult>,
): Promise<void> {
  try {
    await provider.pushSnapshot(merged);
  } catch (cause) {
    throw new SyncPushFailedError(PUSH_FAILED_MESSAGE, result('MERGED_NOT_PUBLISHED', applied), {
      cause,
    });
  }
}

/** §7.2 TTL prune of tombstones older than (now − ttl). */
async function pruneTombstones(driver: IDatabaseDriver, now: number, ttlMs: number): Promise<number> {
  const cutoff = now - ttlMs;
  const res = await driver.execute('DELETE FROM tombstones WHERE deleted_at < ?;', [cutoff]);
  return res.rowsModified;
}

function hardStop(message: string): SyncResult {
  return result('HARD_STOP', { message });
}

function result(status: SyncResult['status'], partial: Partial<SyncResult>): SyncResult {
  return {
    status,
    pulled: partial.pulled ?? 0,
    deleted: partial.deleted ?? 0,
    reparented: partial.reparented ?? 0,
    rejectedCycles: partial.rejectedCycles ?? 0,
    serialisedLoansClosed: partial.serialisedLoansClosed ?? 0,
    bookingsCancelled: partial.bookingsCancelled ?? 0,
    kitLinksBroken: partial.kitLinksBroken ?? 0,
    loanReturnsPreserved: partial.loanReturnsPreserved ?? 0,
    loanInstalmentsPreserved: partial.loanInstalmentsPreserved ?? 0,
    prunedTombstones: partial.prunedTombstones ?? 0,
    clockOffset: partial.clockOffset ?? 0,
    historyInserted: partial.historyInserted ?? 0,
    tagEdgesAdded: partial.tagEdgesAdded ?? 0,
    tagEdgesRemoved: partial.tagEdgesRemoved ?? 0,
    conflicts: partial.conflicts ?? [],
    message: partial.message,
  };
}

export { readSyncMeta };
