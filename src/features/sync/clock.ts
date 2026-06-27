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
