/**
 * mDNS / DNS-SD **discovery** of a Home Assistant instance on the LAN (issue #126) — the
 * listening counterpart to the advertiser in {@link ./advertise.ts}.
 *
 * The thin, impure shell around the pure {@link ./discovery.ts} wire-format module: it owns the
 * `node:dgram` socket and the query/collect/timeout lifecycle, and nothing else. All the testable
 * logic (query encoding, response decoding, the URL preference order, the opt-in gating) is pure.
 *
 * It is **best-effort and advisory**. A discovered address only ever supplies a *default* for
 * `GUBBINS_BRIDGE_HA_URL` when the operator left it unset — an explicit value always wins — and it
 * is not a trust decision: the operator's own long-lived access token is still required, and the
 * bridge's Home Assistant access remains read-only. Every failure path (no socket, no answer, a
 * malformed datagram) resolves to `null` and leaves the bridge to start exactly as it would have.
 *
 * It binds an **ephemeral** port rather than the reserved 5353, which the advertiser or the host's
 * own responder may already hold, and therefore relies on the QU ("unicast response wanted") bit to
 * have its answer sent back directly. A responder that ignores QU and only ever answers by
 * multicast is not heard — the operator sets `GUBBINS_BRIDGE_HA_URL` by hand, exactly as before.
 *
 * Stdlib-only: `node:dgram`, zero runtime dependencies — consistent with the rest of the bridge.
 */
import dgram from 'node:dgram';
import { MDNS_MULTICAST_ADDRESS, MDNS_PORT } from './records.ts';
import {
  createDiscoveryState,
  encodeServiceQuery,
  firstDiscoveryResult,
  HA_SERVICE_TYPE,
  ingestDiscoveryMessage,
  type DiscoveryResult,
} from './discovery.ts';
import type { MdnsLogger } from './advertise.ts';

/**
 * How long to wait for an answer before giving up. Discovery runs *before* the Home Assistant
 * client is built, so this is time the bridge spends not yet serving — short enough that a LAN
 * with no Home Assistant on it barely delays startup, long enough for a responder to reply.
 */
export const DEFAULT_DISCOVERY_TIMEOUT_MS = 2500;
/** A second query is sent after this long, in case the first datagram was dropped. */
const RETRY_AFTER_MS = 600;

export interface DiscoverOptions {
  /** Overall budget in milliseconds; defaults to {@link DEFAULT_DISCOVERY_TIMEOUT_MS}. */
  readonly timeoutMs?: number;
  /** Optional logger (defaults to `console`). */
  readonly logger?: MdnsLogger;
}

/**
 * Ask the LAN for Home Assistant and resolve with the first instance that yields a usable URL, or
 * `null` if none answers within the budget. Never rejects.
 */
export function discoverHomeAssistant(options: DiscoverOptions = {}): Promise<DiscoveryResult | null> {
  const logger = options.logger ?? console;
  const timeoutMs = options.timeoutMs ?? DEFAULT_DISCOVERY_TIMEOUT_MS;
  const query = encodeServiceQuery(HA_SERVICE_TYPE);

  return new Promise<DiscoveryResult | null>((resolve) => {
    let state = createDiscoveryState();
    let socket: dgram.Socket | null = null;
    let timers: ReturnType<typeof setTimeout>[] = [];
    let settled = false;

    const finish = (result: DiscoveryResult | null): void => {
      if (settled) return;
      settled = true;
      for (const timer of timers) clearTimeout(timer);
      timers = [];
      const sock = socket;
      socket = null;
      if (sock) {
        try {
          sock.close();
        } catch {
          // Already closing — nothing to do; the result is what matters.
        }
      }
      resolve(result);
    };

    const later = (ms: number, fn: () => void): void => {
      const timer = setTimeout(fn, ms);
      timer.unref?.();
      timers.push(timer);
    };

    const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    socket = sock;

    sock.on('error', (err) => {
      logger.warn(`Home Assistant discovery skipped (socket error): ${err.message}`);
      finish(null);
    });

    sock.on('message', (msg) => {
      state = ingestDiscoveryMessage(state, msg, HA_SERVICE_TYPE);
      const result = firstDiscoveryResult(state);
      // Resolve as soon as an instance is complete rather than burning the whole budget.
      if (result !== null) finish(result);
    });

    sock.on('listening', () => {
      try {
        // Only needed to *send* to the group; joining it would be pointless here, because a
        // multicast reply is addressed to port 5353 and this socket deliberately holds an
        // ephemeral one. That is why the query sets the QU bit — see `encodeServiceQuery`.
        sock.setMulticastTTL(255);
      } catch (err) {
        // Not fatal: the default TTL still reaches responders on the local link.
        logger.warn(`Home Assistant discovery: could not set multicast TTL (${(err as Error).message}).`);
      }
      const send = (): void => {
        sock.send(query, MDNS_PORT, MDNS_MULTICAST_ADDRESS, (err) => {
          if (err) logger.warn(`Home Assistant discovery query failed: ${err.message}`);
        });
      };
      send();
      if (timeoutMs > RETRY_AFTER_MS) later(RETRY_AFTER_MS, send);
      later(timeoutMs, () => finish(firstDiscoveryResult(state)));
    });

    try {
      sock.bind(); // ephemeral port — never contend for 5353, which the advertiser may hold
    } catch (err) {
      logger.warn(`Home Assistant discovery skipped (bind failed): ${(err as Error).message}`);
      finish(null);
    }
  });
}
