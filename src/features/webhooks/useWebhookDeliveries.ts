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

export type WebhookDeliveriesState =
  /** No bridge is configured on this device, so there is nothing to poll. */
  | { readonly status: 'unconfigured' }
  /** The first poll has not answered yet. */
  | { readonly status: 'loading' }
  | { readonly status: 'ready'; readonly deliveries: readonly WebhookDelivery[] }
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
  const deliveriesRef = useRef<readonly WebhookDelivery[]>([]);
  const inFlightRef = useRef(false);

  const baseUrl = connection?.baseUrl ?? null;
  const token = connection?.token ?? null;
  const fetchImpl = connection?.fetchImpl ?? null;

  const poll = useCallback(async (): Promise<void> => {
    if (baseUrl === null || token === null || fetchImpl === null) return;
    // A slow bridge must not let polls pile up on top of each other.
    if (inFlightRef.current) return;
    inFlightRef.current = true;

    try {
      const result = await fetchWebhookDeliveries({ baseUrl, token, fetchImpl }, cursorRef.current);
      if (!result.ok) {
        setState({ status: 'failed', failure: result.failure });
        return;
      }

      cursorRef.current = result.latestSeq;
      if (result.deliveries.length > 0) {
        // The bridge answers newest-first, and `since` guarantees these are all newer than what we
        // hold — so new rows go on the front.
        deliveriesRef.current = [...result.deliveries, ...deliveriesRef.current].slice(
          0,
          MAX_VISIBLE_DELIVERIES,
        );
      }
      setState({ status: 'ready', deliveries: deliveriesRef.current });
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
