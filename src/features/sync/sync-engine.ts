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
import { STORAGE_THRESHOLDS } from '@/features/storage/tiers';
import { labFlag } from '@/state/stores/useLabStore';
import { measureClockOffset } from './clock';
import { mergeSnapshot } from './merge';
import type { CloudProvider } from './provider';
import { REMOTE_MISSING_MESSAGE, SyncRemoteMissingError } from './sync-errors';
import type { SyncConflict } from './types';

/**
 * §7.2 Tombstone TTL: 180 days in milliseconds.
 *
 * @internal Exported for unit tests only.
 */
export const TOMBSTONE_TTL_MS = 180 * 24 * 60 * 60 * 1000;

export interface SyncResult {
  readonly status: 'SYNCED' | 'PUBLISHED' | 'CLONED' | 'HARD_STOP';
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
    await provider.pushSnapshot(merged);
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
  await provider.pushSnapshot(outcome.merged);
  const pruned = await pruneTombstones(driver, effectiveNow, ttlMs);
  await writeSyncMeta(driver, effectiveNow, offset);

  return result('SYNCED', {
    pulled: outcome.pulled,
    deleted: outcome.deleted,
    reparented: outcome.reparented,
    rejectedCycles: outcome.rejectedCycles,
    serialisedLoansClosed: outcome.serialisedLoansClosed,
    prunedTombstones: pruned,
    clockOffset: offset,
    historyInserted: outcome.historyInserted,
    tagEdgesAdded: outcome.tagEdgesAdded,
    tagEdgesRemoved: outcome.tagEdgesRemoved,
    conflicts: outcome.conflicts,
  });
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
