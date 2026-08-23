/**
 * Polls the bridge's webhook delivery log **only while the Webhooks screen is mounted**
 * (webhooks plan `W7`; see §3.1).
 *
 * "Only while the screen is open" is a design constraint, not an optimisation. The log lives in
 * bridge memory rather than the database, so there is no synced copy to read; the app has to ask
 * over the network, and a background poller would keep a user's bridge awake and their radio busy
 * to populate a screen nobody is looking at. Mounting *is* the subscription, so the interval is
 * cleared on unmount and no request outlives the screen.
 *
 * Each poll passes `since` — the highest sequence number already seen — so it returns only what is
 * new, and a quiet bridge answers with an empty page rather than re-sending the whole log.
 *
 * ## A cursor only means anything to the log that issued it
 *
 * The log is in bridge memory and its sequence numbers count from zero again on every start, so a
 * cursor kept across a bridge restart addresses records that no longer exist. Asking for
 * "everything after 57" from a log that has reached 3 returns nothing, and the three records it
 * *has* — the ones a user restarting to test a fix most wants to see — are never requested again.
 * Carrying on would also mix the old rows with new ones that reuse their sequence numbers.
 *
 * So a restart is detected and treated as what it is: a different log. {@link isLogRestarted} reads
 * the bridge's `logId`, falling back to a `latestSeq` that has gone *backwards* when talking to a
 * bridge too old to report one, and the poller then drops the cursor, discards the accumulated rows
 * and re-reads from the start. The screen says so rather than quietly showing a shorter list.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  fetchWebhookDeliveries,
  type BridgeConnection,
  type WebhookBridgeFailure,
  type WebhookDelivery,
} from './bridge-client';

/** How often to poll while the screen is open. */
export const WEBHOOK_POLL_INTERVAL_MS = 10_000;

/**
 * How many rows to keep in view. The bridge retains its own bounded history; this is simply the
 * point past which more rows stop helping anyone read the screen.
 */
export const MAX_VISIBLE_DELIVERIES = 100;

/**
 * One row, paired with a key that is unique for the lifetime of this hook.
 *
 * `seq` cannot be that key. It is unique only *within* one log instance, and the whole point of the
 * restart handling above is that the app can meet more than one. The counter behind `key` is never
 * reused, so React can never be handed two identical keys — including in the case the fallback
 * detection cannot see (an old bridge that restarted and re-passed the cursor before the next poll).
 */
export interface KeyedWebhookDelivery {
  readonly key: string;
  readonly delivery: WebhookDelivery;
}

export type WebhookDeliveriesState =
  /** No bridge is configured on this device, so there is nothing to poll. */
  | { readonly status: 'unconfigured' }
  /** The first poll has not answered yet. */
  | { readonly status: 'loading' }
  | {
      readonly status: 'ready';
      readonly deliveries: readonly KeyedWebhookDelivery[];
      /**
       * The bridge restarted while this screen was open, so everything logged before it is gone and
       * the rows below begin at the restart. Sticky for the life of the screen — it explains the
       * list a user is still looking at, not a moment that has passed.
       */
      readonly restarted: boolean;
    }
  /**
   * The bridge could not be read. Kept distinct from an empty `ready`: "no deliveries yet" and
   * "webhooks are switched off on your bridge" demand completely different actions from the user,
   * and showing the first when the second is true is how a feature earns a reputation for being
   * broken.
   */
  | { readonly status: 'failed'; readonly failure: WebhookBridgeFailure };

/**
 * @param connection The configured bridge, or `null` when this device has none — in which case
 *   nothing is polled and the state stays `unconfigured`.
 */
export function useWebhookDeliveries(connection: BridgeConnection | null): {
  readonly state: WebhookDeliveriesState;
  /** Poll immediately, without waiting for the next interval (used after a test-fire). */
  readonly refresh: () => void;
} {
  const [state, setState] = useState<WebhookDeliveriesState>(
    connection === null ? { status: 'unconfigured' } : { status: 'loading' },
  );

  // The cursor and the accumulated rows live in refs rather than state: a poll reads them to build
  // its request and its next value, and routing that through state would make every poll depend on
  // the identity of the callback that scheduled it.
  const cursorRef = useRef<number | undefined>(undefined);
  const deliveriesRef = useRef<readonly KeyedWebhookDelivery[]>([]);
  const inFlightRef = useRef(false);
  /** Which log instance the cursor belongs to; `null` from a bridge that reports none. */
  const logIdRef = useRef<string | null>(null);
  const restartedRef = useRef(false);
  /** Monotonic source of row keys. Never reset, so a key is never reused. */
  const nextKeyRef = useRef(0);

  const baseUrl = connection?.baseUrl ?? null;
  const token = connection?.token ?? null;
  const fetchImpl = connection?.fetchImpl ?? null;

  const poll = useCallback(async (): Promise<void> => {
    if (baseUrl === null || token === null || fetchImpl === null) return;
    // A slow bridge must not let polls pile up on top of each other.
    if (inFlightRef.current) return;
    inFlightRef.current = true;

    // Named to avoid shadowing the hook's own `connection` argument; these three are its parts,
    // already narrowed to non-null above.
    const bridge = { baseUrl, token, fetchImpl };
    try {
      let result = await fetchWebhookDeliveries(bridge, cursorRef.current);
      if (!result.ok) {
        setState({ status: 'failed', failure: result.failure });
        return;
      }

      if (isLogRestarted(result, cursorRef.current, logIdRef.current)) {
        // A different log, so the page just fetched was filtered against a cursor that meant
        // nothing to it. Throw away what we hold and read the new log from its start — anything
        // else hides the deliveries recorded between the restart and this poll.
        restartedRef.current = true;
        cursorRef.current = undefined;
        deliveriesRef.current = [];
        result = await fetchWebhookDeliveries(bridge, undefined);
        if (!result.ok) {
          setState({ status: 'failed', failure: result.failure });
          return;
        }
      }

      logIdRef.current = result.logId;
      cursorRef.current = result.latestSeq;
      if (result.deliveries.length > 0) {
        // The bridge answers newest-first, and `since` guarantees these are all newer than what we
        // hold — so new rows go on the front.
        const keyed = result.deliveries.map((delivery) => {
          nextKeyRef.current += 1;
          return { key: String(nextKeyRef.current), delivery };
        });
        deliveriesRef.current = [...keyed, ...deliveriesRef.current].slice(0, MAX_VISIBLE_DELIVERIES);
      }
      setState({
        status: 'ready',
        deliveries: deliveriesRef.current,
        restarted: restartedRef.current,
      });
    } finally {
      inFlightRef.current = false;
    }
  }, [baseUrl, token, fetchImpl]);

  useEffect(() => {
    if (baseUrl === null || token === null || fetchImpl === null) {
      setState({ status: 'unconfigured' });
      return;
    }

    // Switching bridges invalidates both the cursor and the rows — sequence numbers are per-bridge,
    // so carrying a cursor across would silently hide the new bridge's early deliveries.
    cursorRef.current = undefined;
    deliveriesRef.current = [];
    logIdRef.current = null;
    restartedRef.current = false;
    setState({ status: 'loading' });

    let cancelled = false;
    const tick = (): void => {
      if (!cancelled) void poll();
    };

    tick();
    const timer = setInterval(tick, WEBHOOK_POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [baseUrl, token, fetchImpl, poll]);

  const refresh = useCallback(() => {
    void poll();
  }, [poll]);

  return { state, refresh };
}

/**
 * Did this response come from a *different* log than the cursor was issued by?
 *
 * The `logId` is the answer whenever both sides have one — it is minted per log instance, so a
 * change means a restart however the sequence numbers happen to line up. Without it (a bridge
 * predating the field, or the first response of a session) the only evidence is `latestSeq` going
 * backwards, which is unambiguous but not exhaustive: a restarted bridge that logs past the old
 * cursor before the next poll looks, by the numbers, like an ordinary quiet minute. The row keys do
 * not depend on catching that case, so its cost is a short list rather than a corrupt one.
 */
function isLogRestarted(
  result: { readonly latestSeq: number; readonly logId: string | null },
  cursor: number | undefined,
  knownLogId: string | null,
): boolean {
  if (result.logId !== null && knownLogId !== null) return result.logId !== knownLogId;
  return cursor !== undefined && result.latestSeq < cursor;
}
