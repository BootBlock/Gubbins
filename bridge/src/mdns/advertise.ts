/**
 * mDNS / DNS-SD service advertiser (Deferred-work: mDNS / zeroconf discovery).
 *
 * The thin, impure shell around the pure {@link ./records.ts} wire-format module: it owns the
 * `node:dgram` multicast socket and the announce/respond/goodbye lifecycle, and nothing else.
 * All the testable logic (record encoding, question parsing, the opt-in/loopback gating, the
 * address pick) lives in `records.ts`.
 *
 * It is **best-effort and read-only**: it only ever *reads* the host's interfaces and *sends*
 * UDP announcements describing the already-running HTTP service. If the mDNS port can't be
 * bound (another responder already holds it without `SO_REUSEADDR`, no multicast permission),
 * it logs a warning and gives up — it must **never** take down the HTTP server. The
 * advertisement carries **no secret** (see {@link buildTxtEntries}).
 *
 * Stdlib-only: `node:dgram` + `node:os`, zero runtime dependencies — consistent with the rest
 * of the bridge.
 */
import dgram from 'node:dgram';
import {
  DEFAULT_INSTANCE_NAME,
  MDNS_MULTICAST_ADDRESS,
  MDNS_PORT,
  type AdvertisementParams,
  decodeQuestions,
  encodeAnnouncement,
  isQuery,
  isQueryForService,
} from './records.ts';

/** Minimal logger seam (defaults to the console), so tests stay quiet and assertable. */
export interface MdnsLogger {
  log(message: string): void;
  warn(message: string): void;
}

export interface MdnsAdvertiserOptions extends AdvertisementParams {
  /** Optional logger (defaults to `console`). */
  readonly logger?: MdnsLogger;
}

export interface MdnsAdvertiser {
  /** Bind, join the multicast group, and announce. Resolves once started (or skipped). */
  start(): Promise<void>;
  /** Send a goodbye (TTL 0) and close the socket. Always resolves. */
  stop(): Promise<void>;
}

/**
 * Create an advertiser for the running HTTP service. The records are fixed for the session,
 * so the announcement buffer is built once and reused for both the unsolicited announcements
 * and the replies to matching queries.
 */
export function createMdnsAdvertiser(options: MdnsAdvertiserOptions): MdnsAdvertiser {
  const logger = options.logger ?? console;
  const instanceName = options.instanceName ?? DEFAULT_INSTANCE_NAME;
  const announcement = encodeAnnouncement(options);
  const goodbye = encodeAnnouncement(options, { goodbye: true });

  let socket: dgram.Socket | null = null;
  let announceTimer: ReturnType<typeof setTimeout> | null = null;

  function send(buffer: Buffer): void {
    socket?.send(buffer, MDNS_PORT, MDNS_MULTICAST_ADDRESS, (err) => {
      if (err) logger.warn(`mDNS send failed: ${err.message}`);
    });
  }

  function start(): Promise<void> {
    return new Promise<void>((resolve) => {
      const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
      socket = sock;

      sock.on('error', (err) => {
        logger.warn(`mDNS advertiser disabled (socket error): ${err.message}`);
        sock.close();
        socket = null;
        resolve(); // best-effort: never block or crash the bridge
      });

      sock.on('message', (msg) => {
        try {
          if (isQuery(msg) && isQueryForService(decodeQuestions(msg), instanceName)) send(announcement);
        } catch {
          // Ignore malformed packets — a stray UDP datagram must not crash anything.
        }
      });

      sock.on('listening', () => {
        try {
          sock.addMembership(MDNS_MULTICAST_ADDRESS);
          sock.setMulticastTTL(255);
        } catch (err) {
          logger.warn(`mDNS multicast join failed: ${(err as Error).message}`);
        }
        // RFC 6762 recommends a small burst of announcements; send now and once more shortly.
        send(announcement);
        announceTimer = setTimeout(() => send(announcement), 1000);
        announceTimer.unref?.();
        logger.log(`mDNS advertising "${instanceName}" on ${MDNS_MULTICAST_ADDRESS}:${MDNS_PORT}.`);
        resolve();
      });

      sock.bind(MDNS_PORT);
    });
  }

  function stop(): Promise<void> {
    return new Promise<void>((resolve) => {
      if (announceTimer) clearTimeout(announceTimer);
      announceTimer = null;
      const sock = socket;
      socket = null;
      if (!sock) {
        resolve();
        return;
      }
      try {
        sock.send(goodbye, MDNS_PORT, MDNS_MULTICAST_ADDRESS, () => sock.close(() => resolve()));
      } catch {
        sock.close(() => resolve());
      }
    });
  }

  return { start, stop };
}
