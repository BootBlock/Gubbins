/**
 * MQTT connection shell (EI-5) — the thin, impure lifecycle around the pure {@link ./packet.ts}
 * codec, mirroring how `mdns/advertise.ts` wraps the pure `mdns/records.ts`.
 *
 * It owns exactly one thing: a single outbound TCP/TLS connection to the operator's broker and
 * its publish-only lifecycle — connect → CONNECT → CONNACK → (keep-alive ping loop) → publish …,
 * with automatic reconnect on drop. Everything testable (the wire format) lives in `packet.ts`;
 * everything here is the socket plumbing, driven in tests through an **injected fake socket** so
 * no live broker is needed.
 *
 * **Best-effort and outbound-only.** The bridge is an MQTT *client* dialling *out* — it opens no
 * inbound port, so it never violates the "PWA/bridge exposes no inbound server beyond the opt-in
 * HTTP API" posture. A broker that is down, unreachable, or rejects the credentials only logs a
 * secret-free warning and retries with backoff; the HTTP API is entirely unaffected.
 *
 * Stdlib-only: `node:net` / `node:tls`, zero runtime dependencies.
 */
import net from 'node:net';
import tls from 'node:tls';
import {
  CONNACK_REASONS,
  PACKET_TYPE,
  decodeConnack,
  encodeConnect,
  encodeDisconnect,
  encodePingReq,
  encodePublish,
  parsePackets,
  type ConnectOptions,
} from './packet.ts';

/** A resolved broker endpoint parsed from an `mqtt(s)://` URL. */
export interface MqttEndpoint {
  readonly host: string;
  readonly port: number;
  /** True for a TLS transport (`mqtts://` / `mqtt+ssl://`). */
  readonly tls: boolean;
}

/**
 * The minimal socket surface the client needs, so a test can inject a fake without a real TCP
 * connection. The default factory ({@link nodeSocketFactory}) wraps `node:net` / `node:tls`.
 */
export interface RawSocket {
  /** Send bytes to the broker. */
  write(data: Buffer): void;
  /** Tear the socket down (no graceful close). */
  destroy(): void;
  /** The transport is up (TCP connected, or TLS handshake complete). */
  onReady(cb: () => void): void;
  /** Bytes arrived from the broker. */
  onData(cb: (chunk: Buffer) => void): void;
  /** The socket closed (cleanly or not). */
  onClose(cb: () => void): void;
  /** A transport-level error (fires before/with `onClose`). */
  onError(cb: (err: Error) => void): void;
}

/** Creates a fresh socket for one connection attempt. */
export type SocketFactory = (endpoint: MqttEndpoint) => RawSocket;

/** Minimal logger seam (defaults to the console), so tests stay quiet and assertable. */
export interface MqttLogger {
  log(message: string): void;
  warn(message: string): void;
}

/** Default keep-alive (seconds) — the broker drops us if we are silent for 1.5× this. */
export const DEFAULT_KEEP_ALIVE_SECONDS = 60;
/** Default first reconnect delay; doubles each failure up to {@link DEFAULT_MAX_RECONNECT_MS}. */
export const DEFAULT_RECONNECT_BASE_MS = 1_000;
/** Default cap on the reconnect backoff. */
export const DEFAULT_MAX_RECONNECT_MS = 30_000;
/** Default bound on the offline publish buffer; the oldest is dropped past this. */
export const DEFAULT_MAX_BUFFERED = 1_000;

export interface MqttClientOptions {
  readonly endpoint: MqttEndpoint;
  readonly clientId: string;
  readonly username?: string;
  readonly password?: string;
  readonly will?: ConnectOptions['will'];
  readonly keepAliveSeconds?: number;
  readonly reconnectBaseMs?: number;
  readonly maxReconnectMs?: number;
  readonly maxBuffered?: number;
  /** Called each time a CONNACK is accepted — the publisher re-announces its retained state here. */
  readonly onConnect?: () => void;
  /** Injectable socket factory (defaults to the real `node:net`/`node:tls`). */
  readonly socketFactory?: SocketFactory;
  /** Injectable timer for the reconnect backoff (defaults to `setTimeout`). */
  readonly setTimer?: (cb: () => void, ms: number) => { unref?: () => void };
  readonly clearTimer?: (handle: { unref?: () => void }) => void;
  readonly logger?: MqttLogger;
}

export interface MqttClient {
  /** Begin connecting (and keep reconnecting until {@link stop}). Returns immediately. */
  start(): void;
  /**
   * Publish a message. When connected it is written immediately; when offline it is buffered
   * (bounded) and flushed on the next connect. `retain` asks the broker to keep it as the topic's
   * last-known value for late subscribers. Returns whether it went out on the wire right now.
   */
  publish(topic: string, payload: string | Buffer, retain?: boolean): boolean;
  /** Whether a CONNACK-accepted connection is currently up. */
  isConnected(): boolean;
  /** Send a graceful DISCONNECT (suppresses the will) and stop reconnecting. */
  stop(): void;
}

/**
 * Parse an `mqtt(s)://[user:pass@]host[:port]` URL into an endpoint. Credentials in the URL are
 * ignored here (they belong in the dedicated username/password env vars so they never appear in a
 * logged URL); only the transport, host and port are taken. Throws a clear, secret-free error on a
 * bad scheme or host.
 */
export function parseMqttEndpoint(rawUrl: string): MqttEndpoint {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error(`GUBBINS_BRIDGE_MQTT_URL is not a valid URL: "${rawUrl}".`);
  }
  const scheme = url.protocol.replace(/:$/, '').toLowerCase();
  const secure = scheme === 'mqtts' || scheme === 'mqtt+ssl' || scheme === 'tls' || scheme === 'ssl';
  const plain = scheme === 'mqtt' || scheme === 'tcp';
  if (!secure && !plain) {
    throw new Error(`GUBBINS_BRIDGE_MQTT_URL must be mqtt:// or mqtts://; got "${scheme}://".`);
  }
  const host = url.hostname;
  if (host.length === 0) {
    throw new Error('GUBBINS_BRIDGE_MQTT_URL is missing a host.');
  }
  const port = url.port.length > 0 ? Number(url.port) : secure ? 8883 : 1883;
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`GUBBINS_BRIDGE_MQTT_URL port must be in [1, 65535]; got "${url.port}".`);
  }
  return { host, port, tls: secure };
}

/** A secret-free `mqtt(s)://host:port` label for logs (never carries credentials). */
export function endpointLabel(endpoint: MqttEndpoint): string {
  return `${endpoint.tls ? 'mqtts' : 'mqtt'}://${endpoint.host}:${endpoint.port}`;
}

/** The default socket factory: a real `node:net` (or `node:tls`) connection. */
export const nodeSocketFactory: SocketFactory = (endpoint) => {
  const socket = endpoint.tls
    ? tls.connect({ host: endpoint.host, port: endpoint.port })
    : net.connect({ host: endpoint.host, port: endpoint.port });
  const readyEvent = endpoint.tls ? 'secureConnect' : 'connect';
  return {
    write: (data) => void socket.write(data),
    destroy: () => void socket.destroy(),
    onReady: (cb) => void socket.once(readyEvent, cb),
    onData: (cb) => void socket.on('data', cb),
    onClose: (cb) => void socket.once('close', cb),
    onError: (cb) => void socket.on('error', cb),
  };
};

/** Create an MQTT publish-only client. Call {@link MqttClient.start}. */
export function createMqttClient(options: MqttClientOptions): MqttClient {
  const logger = options.logger ?? console;
  const factory = options.socketFactory ?? nodeSocketFactory;
  const setTimer = options.setTimer ?? ((cb, ms) => setTimeout(cb, ms));
  const clearTimer = options.clearTimer ?? ((h) => clearTimeout(h as NodeJS.Timeout));
  const keepAliveSeconds = clampNonNegative(options.keepAliveSeconds ?? DEFAULT_KEEP_ALIVE_SECONDS);
  const reconnectBase = Math.max(1, options.reconnectBaseMs ?? DEFAULT_RECONNECT_BASE_MS);
  const maxReconnect = Math.max(reconnectBase, options.maxReconnectMs ?? DEFAULT_MAX_RECONNECT_MS);
  const maxBuffered = Math.max(1, options.maxBuffered ?? DEFAULT_MAX_BUFFERED);

  let socket: RawSocket | null = null;
  let connected = false;
  let stopped = false;
  let inbound: Buffer = Buffer.alloc(0);
  let reconnectAttempts = 0;
  let reconnectTimer: { unref?: () => void } | null = null;
  let keepAliveTimer: { unref?: () => void } | null = null;
  // Consecutive keep-alive pings sent with NO inbound byte in between. Any inbound data (a
  // PINGRESP, or anything else) resets it to 0; if it reaches 2 the connection is treated as
  // half-open/black-holed and force-reconnected (rather than silently dropping publishes until the
  // OS TCP timeout, which can be minutes).
  let pingsSinceData = 0;
  const buffered: Buffer[] = [];
  const label = endpointLabel(options.endpoint);

  function connect(): void {
    if (stopped) return;
    clearReconnect();
    inbound = Buffer.alloc(0);
    const sock = factory(options.endpoint);
    socket = sock;

    sock.onError((err) => {
      logger.warn(`MQTT socket error (${label}): ${err.message}`);
    });
    sock.onClose(() => {
      if (socket === sock) handleDrop();
    });
    sock.onData((chunk) => {
      if (socket === sock) onData(chunk);
    });
    sock.onReady(() => {
      if (socket !== sock) return;
      sock.write(
        encodeConnect({
          clientId: options.clientId,
          keepAliveSeconds,
          ...(options.username !== undefined ? { username: options.username } : {}),
          ...(options.password !== undefined ? { password: options.password } : {}),
          ...(options.will !== undefined ? { will: options.will } : {}),
        }),
      );
    });
  }

  function onData(chunk: Buffer): void {
    // Any inbound byte (a PINGRESP, a CONNACK, …) proves the connection is alive.
    pingsSinceData = 0;
    inbound = inbound.length === 0 ? chunk : Buffer.concat([inbound, chunk]);
    let parsed;
    try {
      parsed = parsePackets(inbound);
    } catch (err) {
      // A malformed stream from the broker: drop the connection and let backoff retry.
      logger.warn(`MQTT stream error (${label}): ${(err as Error).message}`);
      forceReconnect();
      return;
    }
    inbound = parsed.rest;
    for (const packet of parsed.packets) {
      if (packet.type === PACKET_TYPE.CONNACK) onConnack(packet.body);
      // PINGRESP (and anything else a publish-only client isn't expecting) needs no action.
    }
  }

  function onConnack(body: Buffer): void {
    let result;
    try {
      result = decodeConnack(body);
    } catch (err) {
      logger.warn(`MQTT CONNACK malformed (${label}): ${(err as Error).message}`);
      forceReconnect();
      return;
    }
    if (!result.accepted) {
      const reason = CONNACK_REASONS[result.returnCode] ?? `code ${result.returnCode}`;
      logger.warn(`MQTT connection refused by ${label}: ${reason}. Retrying with backoff.`);
      forceReconnect();
      return;
    }
    connected = true;
    reconnectAttempts = 0;
    pingsSinceData = 0;
    logger.log(`MQTT connected to ${label}.`);
    startKeepAlive();
    flushBuffered();
    options.onConnect?.();
  }

  function startKeepAlive(): void {
    stopKeepAlive();
    armKeepAlive();
  }

  /**
   * Schedule the next keep-alive ping, re-arming itself on each fire (the injectable timer is a
   * one-shot timeout, so we self-reschedule rather than rely on a repeating interval). Ping
   * comfortably inside the keep-alive window (0.75×) so a quiet bridge is never dropped. If two
   * consecutive pings go out with no inbound byte in between (no PINGRESP), the connection is
   * treated as half-open and force-reconnected instead of silently black-holing publishes.
   */
  function armKeepAlive(): void {
    if (keepAliveSeconds === 0) return;
    const intervalMs = Math.max(1000, Math.floor(keepAliveSeconds * 1000 * 0.75));
    const timer = setTimer(() => {
      keepAliveTimer = null;
      if (!connected || !socket) return;
      if (pingsSinceData >= 2) {
        logger.warn(`MQTT keep-alive unanswered by ${label}; reconnecting.`);
        forceReconnect();
        return;
      }
      socket.write(encodePingReq());
      pingsSinceData += 1;
      armKeepAlive();
    }, intervalMs);
    timer.unref?.();
    keepAliveTimer = timer;
  }

  function stopKeepAlive(): void {
    if (keepAliveTimer !== null) {
      clearTimer(keepAliveTimer);
      keepAliveTimer = null;
    }
  }

  function handleDrop(): void {
    const wasConnected = connected;
    connected = false;
    socket = null;
    stopKeepAlive();
    if (stopped) return;
    if (wasConnected) logger.warn(`MQTT disconnected from ${label}; reconnecting.`);
    scheduleReconnect();
  }

  function forceReconnect(): void {
    const sock = socket;
    socket = null;
    connected = false;
    stopKeepAlive();
    sock?.destroy();
    if (!stopped) scheduleReconnect();
  }

  function scheduleReconnect(): void {
    clearReconnect();
    const delay = Math.min(maxReconnect, reconnectBase * 2 ** reconnectAttempts);
    reconnectAttempts += 1;
    const timer = setTimer(() => {
      reconnectTimer = null;
      connect();
    }, delay);
    timer.unref?.();
    reconnectTimer = timer;
  }

  function clearReconnect(): void {
    if (reconnectTimer !== null) {
      clearTimer(reconnectTimer);
      reconnectTimer = null;
    }
  }

  function flushBuffered(): void {
    if (buffered.length === 0 || !socket) return;
    for (const packet of buffered) socket.write(packet);
    buffered.length = 0;
  }

  return {
    start(): void {
      stopped = false;
      connect();
    },

    publish(topic: string, payload: string | Buffer, retain = false): boolean {
      const packet = encodePublish(topic, payload, retain);
      if (connected && socket) {
        socket.write(packet);
        return true;
      }
      // Offline. Only RETAINED messages (last-write-wins state) are buffered for the next connect;
      // a transient (non-retained) event is dropped rather than replayed as if current after a long
      // outage — honest QoS-0 best-effort. The buffer is bounded (oldest dropped past the cap), and
      // since retained topics are last-write-wins, a stale buffered value is superseded by the fresh
      // state the publisher re-announces on reconnect.
      if (!retain) return false;
      buffered.push(packet);
      if (buffered.length > maxBuffered) buffered.shift();
      return false;
    },

    isConnected: () => connected,

    stop(): void {
      stopped = true;
      clearReconnect();
      stopKeepAlive();
      const sock = socket;
      socket = null;
      connected = false;
      if (sock) {
        try {
          sock.write(encodeDisconnect());
        } catch {
          // Best-effort graceful close; destroy regardless.
        }
        sock.destroy();
      }
    },
  };
}

function clampNonNegative(value: number): number {
  return !Number.isFinite(value) || value < 0 ? 0 : Math.floor(value);
}
