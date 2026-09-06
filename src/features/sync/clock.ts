/**
 * NTP-style clock-offset guard (spec §7.3 step 1, Phase 7).
 *
 * Client clocks drift, which would corrupt Last-Write-Wins resolution. Before
 * diffing, the engine asks the provider for an authoritative server time (derived
 * from its response `Date` header — see the `CloudProvider` interface) and computes
 * a `local_clock_offset`, which it adds to every *local* `updated_at` so both sides
 * are compared on the server's timeline. All pure and injectable (callers pass
 * `localNow`), so no real clock is needed in tests.
 *
 * A measured offset is not believed on sight (issue #872). {@link resolveSyncOffset} is the gate
 * between "what the header said" and "the frame this device publishes in", and `runSync` goes
 * through it rather than using {@link measureClockOffset}'s raw result. The clock-skew feature is
 * the one caller that does take the raw result, for the reason its own module records: it is
 * measuring the device, not deciding what to publish, and it applies its own rules to the answer.
 */
import { isPlausibleSkew, shouldRemeasure } from '@/features/clock-skew/skew';
import { CLOCK_UNTRUSTED_MESSAGE, SyncClockUntrustedError } from './sync-errors';

/**
 * Compute the offset to add to local timestamps so they align with server time:
 * `serverNow − localNow`. A positive result means the local clock runs slow. Returns
 * 0 when the server time is unknown (null) — i.e. trust the local clock unchanged.
 */
export function computeClockOffset(serverNow: number | null, localNow: number): number {
  if (serverNow === null || !Number.isFinite(serverNow)) return 0;
  return serverNow - localNow;
}

/** Apply a clock offset to a single local timestamp (§7.3). */
export function applyOffset(localTimestamp: number, offset: number): number {
  return localTimestamp + offset;
}

export interface OffsetMeasurement {
  /** Offset to add to local timestamps to reach server time (0 when no server clock). */
  readonly offset: number;
  /** The server time that was read, or null when the source has no clock. */
  readonly serverNow: number | null;
  /** The freshest local reading (taken *after* the request), for use as "now". */
  readonly localNow: number;
}

/**
 * Measure the local→server clock offset with NTP-style midpoint compensation.
 *
 * A server timestamp is stamped roughly halfway through the request/response round-trip, so
 * comparing it against a local reading taken *before* the request (as the engine used to) charges
 * the entire round-trip latency to the offset — a 200 ms link reads as 200 ms of clock skew even
 * when the clocks agree perfectly, which then mis-resolves Last-Write-Wins on that scale. Sampling
 * the local clock either side of `readServerTime` and comparing the server stamp against the
 * *midpoint* of those two readings cancels the symmetric part of the latency, leaving the genuine
 * skew. This is the standard NTP estimator (assuming roughly symmetric outbound/return delay).
 *
 * Pure but for the injected `now` and `readServerTime`, so it is fully unit-testable.
 */
export async function measureClockOffset(
  now: () => number,
  readServerTime: () => Promise<number | null>,
): Promise<OffsetMeasurement> {
  const before = now();
  const serverNow = await readServerTime();
  const after = now();
  // Round so the midpoint stays an integer epoch-ms like every other timestamp in the system.
  const localMidpoint = Math.round((before + after) / 2);
  return {
    offset: computeClockOffset(serverNow, localMidpoint),
    serverNow,
    localNow: after,
  };
}

/**
 * The device's last persisted clock-skew measurement — the same quantity {@link measureClockOffset}
 * produces, measured independently by `features/clock-skew`. That measurement is taken at boot and
 * not renewed while the app runs, which is what bounds how long a stale one can stand.
 */
export interface PersistedClockSkew {
  /** Milliseconds to add to the raw local clock to reach true time; 0 when unmeasured. */
  readonly skewMs: number;
  /** Raw-clock epoch-ms of that measurement; 0 when never measured. */
  readonly measuredAt: number;
}

/** The publishing frame a pass may use, once the reading behind it has been believed. */
export interface ResolvedSyncOffset {
  /** Offset to add to local timestamps to reach server time. */
  readonly offset: number;
  /**
   * "Now" in the server frame, derived from {@link ResolvedSyncOffset.offset} rather than read
   * separately.
   */
  readonly effectiveNow: number;
}

/**
 * How far a fresh reading may sit from the persisted measurement of the same clock before the two
 * are treated as contradicting each other rather than agreeing.
 *
 * The persisted value is quantised to whole seconds over a two-second deadband, the midpoint
 * estimator leaves residual asymmetric-latency error on that same scale, and a device clock drifts
 * by well under a second across the hour {@link shouldRemeasure} lets a stored reading stand for.
 * A minute is an order of magnitude past all of that, so agreement here is not a coincidence. It
 * must also stay below `SKEW_NOTICE_MS` (`features/clock-skew/skew`), so a disagreement large
 * enough that the app would *tell* the user their clock is wrong is never quietly accepted as one.
 * That ordering is two separate literals, so `clock-offset-guard.test.ts` drives the guard with a
 * disagreement of exactly `SKEW_NOTICE_MS` and requires a refusal — raising this past the notice
 * threshold turns that test red rather than silently widening what the guard will swallow.
 */
export const OFFSET_CORROBORATION_TOLERANCE_MS = 60_000;

/**
 * Decide whether a measured offset may become the frame this device publishes in (issue #872).
 *
 * Every row a pass pushes is stamped `local + offset`, so this one number decides which device
 * wins every Last-Write-Wins comparison in the vault — and its only source is an HTTP `Date`
 * header, which nothing authenticates. A broken proxy or a captive portal that answers with a time
 * far in the future makes this device's rows beat every peer's genuinely newer edit, silently and
 * for as long as the inflated stamps stand: they win the comparison, so no conflict is recorded.
 *
 * Two checks stand between the reading and the frame:
 *
 *  1. **A bound.** {@link isPlausibleSkew} — the same test the clock-skew feature already applies
 *     to the same header, so the two cannot disagree about what counts as nonsense.
 *  2. **Corroboration.** The device measures this very quantity elsewhere, at a different time,
 *     and persists it. When that measurement is fresh enough to still be believed, a reading that
 *     contradicts it by more than {@link OFFSET_CORROBORATION_TOLERANCE_MS} is one of two readings
 *     that cannot both be right, and nothing here can say which.
 *
 * A failed check **stops the pass** rather than falling back to an offset of `0`. Zeroing is not
 * the safe default it looks like: a device whose clock is genuinely a year slow depends on the
 * offset to publish in the true frame, so zeroing would have it publish every row a year in the
 * past and lose every comparison it should win. Refusing to publish at all is the only answer that
 * is wrong in neither direction, and it is loud — the sync screen reports it — where the damage it
 * replaces was silent.
 *
 * `serverNow === null` is not a failed check but the absence of one, and keeps the pre-existing
 * "trust the local clock" behaviour: every shipped provider answers `null` from `getServerTime()`,
 * and `httpTimeSource` degrades every failure to it. A non-finite reading is read the same way —
 * it is not a measurement, so there is nothing to validate and nothing to apply.
 *
 * Two limits are worth stating rather than leaving a reader to assume otherwise. The corroborator
 * is a second reading *at a different time*, not from a different source — both come from the same
 * origin's `Date` header — so an intermediary that lies consistently across both is not caught by
 * anything here, and a device with no stored measurement at all has only the bound. And a
 * contradiction says the two readings cannot both be right, never which one is: whichever caused
 * it, the pass stops.
 *
 * The corroborator is also only as fresh as the clock-skew feature's own measurement, which is
 * taken at boot and not renewed during a session — so a session running longer than
 * `SKEW_REMEASURE_INTERVAL_MS` is left with the bound alone. Feeding accepted readings back in to
 * keep it fresh is the obvious repair, and is deliberately not done: the test is
 * `|reading − corroborator|`, so a corroborator that moves with each reading it has just approved
 * bounds the *step* rather than the total, and a source drifting a little under the tolerance on
 * every pass could then walk this device arbitrarily far ahead, one approved step at a time —
 * the very harm this guard exists to stop, reached slowly instead of at once.
 *
 * @throws {SyncClockUntrustedError} when the reading may not become the publishing frame.
 */
export function resolveSyncOffset(
  measurement: OffsetMeasurement,
  persisted: PersistedClockSkew | null,
): ResolvedSyncOffset {
  const { serverNow, localNow, offset } = measurement;

  // No reading was taken (or the provider answered with something that is not a time).
  if (serverNow === null || !Number.isFinite(serverNow)) {
    return { offset: 0, effectiveNow: localNow };
  }

  if (!isPlausibleSkew(offset)) {
    throw new SyncClockUntrustedError(CLOCK_UNTRUSTED_MESSAGE);
  }

  // Only a measurement fresh enough that the clock-skew feature would not yet re-take it can
  // corroborate. `shouldRemeasure` also reports stale for a stamp in the future, which is what a
  // clock corrected *backwards* leaves behind — a correction forwards does not, so that case is a
  // genuine contradiction and is refused until the stored reading ages out. The message the
  // refusal carries says so.
  const corroborator =
    persisted !== null && persisted.measuredAt > 0 && !shouldRemeasure(persisted.measuredAt, localNow)
      ? persisted.skewMs
      : null;

  if (corroborator !== null && Math.abs(offset - corroborator) > OFFSET_CORROBORATION_TOLERANCE_MS) {
    throw new SyncClockUntrustedError(CLOCK_UNTRUSTED_MESSAGE);
  }

  // Derived from the offset, never read separately: `localNow` is sampled *after* the round-trip,
  // so this is the server's clock carried forward to the moment the pass actually starts rather
  // than the half-round-trip-stale stamp the header carried. It also cannot be non-finite once the
  // offset above has been checked, which the older `serverNow ?? localNow` could not promise —
  // `??` does not catch `NaN`.
  return { offset, effectiveNow: localNow + offset };
}
