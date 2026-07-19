/**
 * clock-skew — bridges the measured device-clock error into the {@link import('@/lib/clock') clock}.
 *
 * The counterpart to `features/lab/lab-clock.ts`, and it is not a hook for the same reason
 * (see that module's header): the correction has to be in place **before the first render**,
 * because the date-driven queries fire as the app mounts and cache their answers. An offset
 * applied in a mount effect would arrive after those reads had already evaluated against the
 * wrong day.
 *
 * So {@link startClockSkew} runs in two stages:
 *
 *  1. **Synchronously**, apply the last persisted skew. The store hydrates from localStorage
 *     before first paint, so a device with a known-wrong clock is corrected from the very first
 *     evaluation rather than after a network round-trip.
 *  2. **In the background**, take a fresh measurement and refine it. This is deliberately not
 *     awaited — boot must never block on the network, and a device that fails to measure keeps
 *     whatever correction it already had rather than lurching back to the raw system clock.
 *
 * The measurement reuses the sync layer's NTP-style estimator so there is one implementation of
 * "what time does the server think it is" rather than a second, subtly-different one here.
 */
import { setClockSkewMs } from '@/lib/clock';
import { measureClockOffset } from '@/features/sync/clock';
import { httpTimeSource } from '@/features/sync/time-source';
import { useClockSkewStore } from '@/state/stores/useClockSkewStore';
import { isPlausibleSkew, quantiseSkew, shouldRemeasure } from './skew';

/**
 * Record a freshly-measured raw offset, quantising it first so neither the clock nor the stored
 * value ever carries more precision than the source has (see `skew.ts`).
 *
 * Note this deliberately does *not* piggy-back on the offset the sync engine already measures on
 * every run. `SyncResult.clockOffset` is `0` both when the clocks genuinely agree and when no
 * server clock could be read at all (a storage Hard Stop returns before measuring; every shipped
 * provider returns `null` from `getServerTime()`), and those two cases are indistinguishable from
 * the result alone — so feeding it in here would let a failed measurement silently erase a real,
 * known correction. The measurement below checks `serverNow` instead, which cannot be confused.
 */
export function recordMeasuredSkew(rawOffsetMs: number): boolean {
  if (!isPlausibleSkew(rawOffsetMs)) return false;
  // Only the store is written; the subscription installed by `startClockSkew` is what pushes the
  // value onto the clock. One write path means the store and the clock cannot drift apart.
  useClockSkewStore.getState().recordSkew(quantiseSkew(rawOffsetMs), Date.now());
  return true;
}

/**
 * Apply the persisted skew, then refresh it in the background if it is stale, and keep the clock
 * in step with later changes. Returns the unsubscribe; treat it as a once-per-boot call.
 */
export function startClockSkew(): () => void {
  const { skewMs, measuredAt } = useClockSkewStore.getState();
  setClockSkewMs(skewMs);

  // Subscribe *before* measuring so the background reading below is applied through the same
  // single path as every later change.
  const unsubscribe = useClockSkewStore.subscribe((state, previous) => {
    if (state.skewMs !== previous.skewMs) setClockSkewMs(state.skewMs);
  });

  // A device clock drifts on the scale of days, so re-deriving the correction on every launch is
  // a network round-trip spent to re-learn what we already know. Measure only once the stored
  // reading has aged out (or when the stamp is missing/in the future — see `shouldRemeasure`).
  if (shouldRemeasure(measuredAt, Date.now())) {
    // Fire-and-forget: boot must never block on the network. `httpTimeSource` degrades every
    // failure to `null`, and `measureClockOffset` maps that to an offset of 0 — which we must
    // *not* treat as "the clock is now perfect", or an offline boot would discard a real, known
    // correction. Only a reading that actually produced a server time may update the skew.
    void (async () => {
      try {
        const { offset, serverNow } = await measureClockOffset(() => Date.now(), httpTimeSource);
        if (serverNow !== null) recordMeasuredSkew(offset);
      } catch {
        // Never let a clock measurement break boot; the persisted correction stands.
      }
    })();
  }

  return unsubscribe;
}
