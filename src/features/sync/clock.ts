/**
 * NTP-style clock-offset guard (spec §7.3 step 1, Phase 7).
 *
 * Client clocks drift, which would corrupt Last-Write-Wins resolution. Before
 * diffing, the engine asks the provider for an authoritative server time (derived
 * from its response `Date` header — see the `CloudProvider` interface) and computes
 * a `local_clock_offset`, which it adds to every *local* `updated_at` so both sides
 * are compared on the server's timeline. All pure and injectable (callers pass
 * `localNow`), so no real clock is needed in tests.
 */

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
