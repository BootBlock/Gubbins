/**
 * Automatic orphaned-image sweep (issue #206).
 *
 * The full-resolution WebP files live as raw OPFS files that only the *main thread* can touch,
 * while the two paths that remove their owning `item_images` rows — an item hard-delete and the
 * sync merge's `applyPlan` — both run inside the database worker, where no trigger or cascade can
 * reach OPFS. Deleting an item (directly, via a cascaded location delete, or because a peer
 * deleted it and the merge applied that) therefore leaves its full-resolution file behind. On a
 * busy, synced inventory these dead files accumulate indefinitely, pushing storage toward the
 * eviction threshold — and until now only a *manual* Database-Maintenance sweep reclaimed them.
 *
 * The manual sweep ({@link sweepOrphanImages}) already does exactly the right thing: it compares
 * the raw OPFS files against the authoritative post-state database (every image-owning table, not
 * just `item_images`) and removes only files no row points at. So rather than re-derive every FK
 * cascade at each delete site, this runs that same sweep automatically — on a throttled schedule —
 * so the reclaim happens without the user finding the maintenance dialog.
 *
 * **Race safety.** The media add-pipeline writes the OPFS file *before* committing its
 * `item_images` row, so a just-written file legitimately has no owning row for a brief window. The
 * automatic sweep must never delete such a file, so it works from {@link listImageFilenamesOlderThan}
 * — a file younger than {@link SWEEP_MIN_FILE_AGE_MS} is simply not offered to the sweep this round
 * and is picked up later once it has aged past the margin (by which point, if it really is an
 * orphan, its row is long gone). The single-tab guard (§2.2.7) means only one tab ever owns the
 * database, so there is no cross-tab add racing this sweep either.
 *
 * The scheduling decision ({@link isOrphanSweepDue}) is pure and unit-tested; the run
 * ({@link runAutoOrphanSweep}) takes its side effects as injected dependencies so the same tests
 * drive it without OPFS or `localStorage`.
 */
import {
  browserMaintenancePorts,
  sweepOrphanImages,
  type MaintenancePorts,
  type OrphanSweepResult,
} from './db-maintenance-actions';
import { listImageFilenamesOlderThan } from '@/features/images/opfs-images';
import { LAST_ORPHAN_SWEEP_KEY } from '@/lib/storage-keys';

/**
 * How often the automatic sweep may run, at most. Reclaiming dead bytes is not time-critical —
 * the file only ever grows between sweeps — so twice a day is ample and keeps the work rare.
 */
export const ORPHAN_SWEEP_INTERVAL_MS = 12 * 60 * 60 * 1000;

/**
 * The safety margin below which a file is considered possibly mid-add and is left untouched (see
 * the race-safety note above). Vastly larger than the file-write→row-commit gap it guards (one
 * worker RPC round-trip), so it never skips a genuine orphan for long while making the add race
 * impossible.
 */
export const SWEEP_MIN_FILE_AGE_MS = 5 * 60 * 1000;

/**
 * Whether an automatic sweep is due: never swept, or the interval has elapsed since the last one.
 * Pure, so the cadence is tested without a clock or storage. Mirrors `isArchiveDue`.
 */
export function isOrphanSweepDue(
  lastSweptAt: number | null,
  now: number,
  intervalMs: number = ORPHAN_SWEEP_INTERVAL_MS,
): boolean {
  if (lastSweptAt === null) return true;
  return now - lastSweptAt >= intervalMs;
}

/** The side effects {@link runAutoOrphanSweep} needs, injected so the run is unit-testable. */
export interface AutoSweepDeps {
  /** The current time (`Date.now()` in production). */
  readonly now: number;
  /** Read the persisted last-swept timestamp, or `null` when never swept. */
  readonly readLastSweptAt: () => number | null;
  /** Persist the last-swept timestamp. */
  readonly writeLastSweptAt: (at: number) => void;
  /**
   * Build the maintenance ports for one sweep, given the safety margin and clock. The default
   * (browser) implementation wires OPFS so the sweep only sees files older than `minFileAgeMs`.
   */
  readonly makePorts: (minFileAgeMs: number, now: number) => MaintenancePorts;
  /** Override the throttle interval (defaults to {@link ORPHAN_SWEEP_INTERVAL_MS}). */
  readonly intervalMs?: number;
}

/**
 * Run the orphan sweep if it is due, stamping the last-swept time on success. Returns the sweep
 * result, or `null` when it was skipped as not-yet-due. Never throws for an unreadable OPFS — the
 * sweep reports `supported: false` and the timestamp is left unstamped so the next launch retries.
 */
export async function runAutoOrphanSweep(deps: AutoSweepDeps): Promise<OrphanSweepResult | null> {
  if (!isOrphanSweepDue(deps.readLastSweptAt(), deps.now, deps.intervalMs)) return null;

  const result = await sweepOrphanImages(deps.makePorts(SWEEP_MIN_FILE_AGE_MS, deps.now));

  // Only record the run when OPFS was actually readable. An "unsupported" result scanned
  // nothing, so stamping it would suppress every future sweep for a full interval on a platform
  // that might support OPFS moments later (the header-injecting worker still warming up, say).
  if (result.supported) deps.writeLastSweptAt(deps.now);
  return result;
}

/** Read the last-swept timestamp from `localStorage`; `null` when absent or unparseable. */
function readLastSweptAt(): number | null {
  try {
    const raw = localStorage.getItem(LAST_ORPHAN_SWEEP_KEY);
    if (raw === null) return null;
    const value = Number(raw);
    return Number.isFinite(value) ? value : null;
  } catch {
    // localStorage unavailable (private mode / disabled) — treat as never swept.
    return null;
  }
}

/** Persist the last-swept timestamp; a storage failure is non-fatal (the sweep still ran). */
function writeLastSweptAt(at: number): void {
  try {
    localStorage.setItem(LAST_ORPHAN_SWEEP_KEY, String(at));
  } catch {
    // Full or disabled storage — worst case the next launch re-sweeps, which is harmless.
  }
}

/**
 * The browser wiring: run the automatic sweep with real OPFS + `localStorage`. Best-effort and
 * non-blocking — callers fire-and-forget it. The ports reuse {@link browserMaintenancePorts} but
 * swap in the age-filtered file listing so an in-flight add is never swept.
 */
export function runAutoOrphanSweepInBrowser(now: number = Date.now()): Promise<OrphanSweepResult | null> {
  return runAutoOrphanSweep({
    now,
    readLastSweptAt,
    writeLastSweptAt,
    makePorts: (minFileAgeMs, at) => ({
      ...browserMaintenancePorts(),
      listImageFilenames: () => listImageFilenamesOlderThan(minFileAgeMs, at),
    }),
  });
}
