/**
 * Env-driven bridge configuration (Phase HA-3).
 *
 * The HTTP server (`server.ts`) and snapshot watcher (`watcher.ts`) are configured
 * entirely from the environment so **no secret or local path is ever committed**: the
 * bearer token and the snapshot path live in a git-ignored `.env` (see `.env.example`
 * for the placeholder shape), loaded at startup by `serve.mjs`.
 *
 * Pure and side-effect-free: it only reads the record handed to it (defaulting to
 * `process.env`) and never touches disk or the network — so it is trivially testable.
 *
 *   GUBBINS_BRIDGE_TOKEN          (required) — shared bearer token Home Assistant must send.
 *   GUBBINS_SNAPSHOT_PATH         (required) — absolute path to the synced gubbins-sync.json.
 *   GUBBINS_BRIDGE_HOST           (optional) — bind address; defaults to 127.0.0.1 (local).
 *   GUBBINS_BRIDGE_PORT           (optional) — TCP port; defaults to 8787.
 *   GUBBINS_BRIDGE_RATE_CAPACITY  (optional) — per-IP burst; defaults to 60. 0 disables.
 *   GUBBINS_BRIDGE_RATE_REFILL    (optional) — per-IP sustained req/sec; defaults to 1.
 *   GUBBINS_BRIDGE_MDNS           (optional) — advertise over mDNS for HA auto-discovery;
 *                                  off by default, and auto-skipped on a loopback bind.
 *   GUBBINS_BRIDGE_MDNS_NAME      (optional) — service instance name in the advertisement.
 *   GUBBINS_BRIDGE_ALLOW_WRITES   (optional) — opt into the limited write endpoints (stock
 *                                  adjust). OFF by default; the bridge is read-only unless set.
 *   GUBBINS_BRIDGE_ALLOW_PUSH     (optional) — opt into the snapshot-ingest endpoint (the PWA
 *                                  "push to bridge"). OFF by default, independent of writes.
 *   GUBBINS_BRIDGE_MAX_PUSH_BYTES (optional) — hard cap on a pushed snapshot's size in bytes;
 *                                  defaults to {@link DEFAULT_MAX_PUSH_BYTES} (64 MiB).
 *   GUBBINS_BRIDGE_EVENTS         (optional) — enable the read-only SSE event stream at
 *                                  GET /api/v1/events. Off by default; implied by _WEBHOOKS.
 *   GUBBINS_BRIDGE_WEBHOOKS       (optional) — enable opt-in signed outbound webhooks. Off by
 *                                  default; also lights up the event stream (shared pipeline).
 *   GUBBINS_BRIDGE_WEBHOOKS_FILE  (optional) — path to the git-ignored JSON webhook-target list
 *                                  (default `webhooks.json`); the target SECRETS live only here.
 *   GUBBINS_BRIDGE_WEBHOOKS_TARGETS (optional) — inline JSON target list (wins over the file);
 *                                  carries secrets, so keep it in the git-ignored .env only.
 *   GUBBINS_BRIDGE_MQTT           (optional) — connect OUT to an MQTT broker and publish inventory
 *                                  state + the EI-1 events. Off by default (outbound-only; no port).
 *   GUBBINS_BRIDGE_MQTT_URL       (required when MQTT on) — mqtt:// or mqtts:// broker URL.
 *   GUBBINS_BRIDGE_MQTT_USERNAME  (optional) — broker username; in .env only.
 *   GUBBINS_BRIDGE_MQTT_PASSWORD  (optional) — broker password; in .env only, never logged.
 *   GUBBINS_BRIDGE_MQTT_PREFIX    (optional) — topic prefix (default `gubbins`).
 *   GUBBINS_BRIDGE_MQTT_CLIENT_ID (optional) — MQTT client id (default `gubbins-bridge`).
 *   GUBBINS_BRIDGE_MQTT_DISCOVERY (optional) — also emit Home Assistant MQTT-discovery configs so
 *                                  HA auto-creates entities with no custom component. Off by default.
 *   GUBBINS_BRIDGE_MQTT_DISCOVERY_PREFIX (optional) — HA discovery prefix (default `homeassistant`).
 */
import { DEFAULT_RATE_CAPACITY, DEFAULT_RATE_REFILL_PER_SEC, type RateLimiterOptions } from './rate-limit.ts';

/** Default bind address: loopback only, so the bridge is **not** LAN-reachable unless
 * the operator deliberately opts in via {@link LAN_HOST}. */
export const DEFAULT_HOST = '127.0.0.1';
/** Opt-in "expose on every interface" bind address — a deliberate LAN-exposure choice. */
export const LAN_HOST = '0.0.0.0';
/** Default TCP port when `GUBBINS_BRIDGE_PORT` is unset. */
export const DEFAULT_PORT = 8787;
/**
 * Default hard cap on a pushed snapshot's size (64 MiB). A full versioned-JSON snapshot of a
 * large vault — thousands of items plus their base-64 thumbnails — sits comfortably below this,
 * while the cap stops a runaway or hostile upload from filling the disk (e.g. an SD card on a
 * Pi/NAS) or the validation parse from exhausting memory. Tunable via
 * `GUBBINS_BRIDGE_MAX_PUSH_BYTES` (lower it on a constrained device). The body is streamed to a
 * temp file as it arrives, so a body larger than this is rejected before it is all on disk.
 */
export const DEFAULT_MAX_PUSH_BYTES = 64 * 1024 * 1024;

/** A resolved, validated bridge configuration. */
export interface BridgeConfig {
  /** Bind address. {@link DEFAULT_HOST} (loopback) unless explicitly overridden. */
  readonly host: string;
  /** TCP port in `[1, 65535]`. */
  readonly port: number;
  /** Shared bearer token required on every request. Never logged, never committed. */
  readonly token: string;
  /** Absolute path to the synced `gubbins-sync.json` snapshot the watcher reads. */
  readonly snapshotPath: string;
  /**
   * Per-IP rate-limit settings, or `null` when explicitly disabled
   * (`GUBBINS_BRIDGE_RATE_CAPACITY=0`) to defer entirely to the LAN/firewall.
   */
  readonly rateLimit: RateLimiterOptions | null;
  /**
   * Whether the operator opted into mDNS / zeroconf advertising (`GUBBINS_BRIDGE_MDNS=on`).
   * Off by default. Even when on, advertising is auto-skipped on a loopback bind (it would
   * be pointless) — see `resolveMdnsPlan` in `mdns/records.ts`. Carries no secret.
   */
  readonly mdns: boolean;
  /** Optional service instance name for the advertisement (`GUBBINS_BRIDGE_MDNS_NAME`). */
  readonly mdnsInstanceName: string | undefined;
  /**
   * Whether the operator opted into the limited write endpoints (`GUBBINS_BRIDGE_ALLOW_WRITES=on`).
   * **Off by default** — the bridge is strictly read-only unless this is set. When on, the
   * POST stock-adjust endpoints become available (same bearer token + rate limit); each write
   * round-trips through the app's own mutation + the §7.3 sync merge, never a bespoke SQL write.
   */
  readonly allowWrites: boolean;
  /**
   * Whether the operator opted into the snapshot-ingest endpoint (`GUBBINS_BRIDGE_ALLOW_PUSH=on`)
   * — the PWA "push to bridge". **Off by default**, and **independent of {@link allowWrites}**
   * (push replaces the whole served snapshot; the limited writes apply a surgical per-item change
   * — orthogonal opt-ins). When on, `POST /api/v1/snapshot` accepts the same versioned backup
   * JSON the watcher reads and rewrites the snapshot atomically (same bearer token + rate limit).
   */
  readonly allowPush: boolean;
  /** Hard cap (bytes) on a pushed snapshot body. Defaults to {@link DEFAULT_MAX_PUSH_BYTES}. */
  readonly maxPushBytes: number;
  /**
   * Whether the operator opted into the read-only **event stream** (`GUBBINS_BRIDGE_EVENTS=on`)
   * — the EI-1 `GET /api/v1/events` SSE feed. **Off by default.** Also implied by {@link webhooks}
   * (webhook delivery reuses the same event pipeline, so enabling webhooks lights up the stream
   * too). When neither is on, `GET /api/v1/events` is a `404`. Read-only; carries no secret.
   */
  readonly events: boolean;
  /**
   * Whether the operator opted into **outbound webhooks** (`GUBBINS_BRIDGE_WEBHOOKS=on`).
   * **Off by default.** When on, each event is POSTed (HMAC-signed) to every configured target;
   * the targets + their secrets come from {@link webhooksFile} or {@link webhooksInline}, never
   * from a committed file. Read-only w.r.t. inventory (a webhook never mutates data).
   */
  readonly webhooks: boolean;
  /**
   * Path to the git-ignored JSON file listing the webhook targets (`GUBBINS_BRIDGE_WEBHOOKS_FILE`);
   * `undefined` falls back to `webhooks.json` in the working directory. Only read when
   * {@link webhooks} is on. The **secrets live only in this file** (or {@link webhooksInline}).
   */
  readonly webhooksFile: string | undefined;
  /**
   * Inline JSON webhook-target list (`GUBBINS_BRIDGE_WEBHOOKS_TARGETS`), for operators who prefer
   * env-only config; when set it wins over {@link webhooksFile}. Carries the target secrets, so it
   * belongs in the git-ignored `.env` only.
   */
  readonly webhooksInline: string | undefined;
  /**
   * Whether the operator opted into **outbound MQTT publishing** (`GUBBINS_BRIDGE_MQTT=on`).
   * **Off by default.** When on, the bridge connects OUT to {@link mqttUrl} (an MQTT *client* — no
   * inbound port) and publishes retained inventory state + the EI-1 events. Implies the event
   * pipeline (like {@link webhooks}) so events reach the broker even without the SSE stream.
   */
  readonly mqtt: boolean;
  /** The broker URL (`mqtt://` / `mqtts://`). Required (non-empty) when {@link mqtt} is on. */
  readonly mqttUrl: string | undefined;
  /** Optional broker username (`GUBBINS_BRIDGE_MQTT_USERNAME`); `.env` only. */
  readonly mqttUsername: string | undefined;
  /** Optional broker password (`GUBBINS_BRIDGE_MQTT_PASSWORD`); `.env` only, never logged. */
  readonly mqttPassword: string | undefined;
  /** Topic prefix every published topic hangs under (`GUBBINS_BRIDGE_MQTT_PREFIX`, default `gubbins`). */
  readonly mqttPrefix: string;
  /** MQTT client id (`GUBBINS_BRIDGE_MQTT_CLIENT_ID`, default `gubbins-bridge`). */
  readonly mqttClientId: string;
  /**
   * Whether to also emit Home Assistant MQTT-discovery configs (`GUBBINS_BRIDGE_MQTT_DISCOVERY=on`)
   * so HA auto-creates entities with no custom component. Off by default; only meaningful when
   * {@link mqtt} is on.
   */
  readonly mqttDiscovery: boolean;
  /** HA discovery prefix (`GUBBINS_BRIDGE_MQTT_DISCOVERY_PREFIX`, default `homeassistant`). */
  readonly mqttDiscoveryPrefix: string;
}

/** The subset of the environment we read; `process.env`-shaped for easy injection in tests. */
export type Env = Readonly<Record<string, string | undefined>>;

/**
 * Resolve the bridge configuration from the environment. Throws a clear, secret-free
 * error when a required value is missing or a port is out of range, so a misconfigured
 * deployment fails loudly at startup rather than serving unauthenticated.
 */
export function loadConfig(env: Env = process.env): BridgeConfig {
  const token = (env.GUBBINS_BRIDGE_TOKEN ?? '').trim();
  if (token.length === 0) {
    throw new Error('GUBBINS_BRIDGE_TOKEN is required (set it in a git-ignored .env — see .env.example).');
  }

  const snapshotPath = loadSnapshotPath(env);

  const host = (env.GUBBINS_BRIDGE_HOST ?? '').trim() || DEFAULT_HOST;
  const port = parsePort(env.GUBBINS_BRIDGE_PORT);
  const rateLimit = parseRateLimit(env);
  const mdns = parseBool(env.GUBBINS_BRIDGE_MDNS, false, 'GUBBINS_BRIDGE_MDNS');
  const mdnsInstanceName = (env.GUBBINS_BRIDGE_MDNS_NAME ?? '').trim() || undefined;
  const allowWrites = parseBool(env.GUBBINS_BRIDGE_ALLOW_WRITES, false, 'GUBBINS_BRIDGE_ALLOW_WRITES');
  const allowPush = parseBool(env.GUBBINS_BRIDGE_ALLOW_PUSH, false, 'GUBBINS_BRIDGE_ALLOW_PUSH');
  const webhooks = parseBool(env.GUBBINS_BRIDGE_WEBHOOKS, false, 'GUBBINS_BRIDGE_WEBHOOKS');
  // The event stream is on when explicitly enabled OR implied by webhooks (they share the pipeline).
  const events = parseBool(env.GUBBINS_BRIDGE_EVENTS, false, 'GUBBINS_BRIDGE_EVENTS') || webhooks;
  const webhooksFile = (env.GUBBINS_BRIDGE_WEBHOOKS_FILE ?? '').trim() || undefined;
  const webhooksInline = (env.GUBBINS_BRIDGE_WEBHOOKS_TARGETS ?? '').trim() || undefined;

  const mqtt = parseBool(env.GUBBINS_BRIDGE_MQTT, false, 'GUBBINS_BRIDGE_MQTT');
  const mqttUrl = (env.GUBBINS_BRIDGE_MQTT_URL ?? '').trim() || undefined;
  if (mqtt && mqttUrl === undefined) {
    throw new Error('GUBBINS_BRIDGE_MQTT is on but GUBBINS_BRIDGE_MQTT_URL is unset (set it in .env).');
  }
  const mqttUsername = (env.GUBBINS_BRIDGE_MQTT_USERNAME ?? '').trim() || undefined;
  // Password is intentionally NOT trimmed (a leading/trailing space could be significant); only a
  // truly empty value becomes undefined.
  const mqttPassword =
    env.GUBBINS_BRIDGE_MQTT_PASSWORD !== undefined && env.GUBBINS_BRIDGE_MQTT_PASSWORD.length > 0
      ? env.GUBBINS_BRIDGE_MQTT_PASSWORD
      : undefined;
  const mqttPrefix = (env.GUBBINS_BRIDGE_MQTT_PREFIX ?? '').trim() || 'gubbins';
  const mqttClientId = (env.GUBBINS_BRIDGE_MQTT_CLIENT_ID ?? '').trim() || 'gubbins-bridge';
  const mqttDiscovery = parseBool(env.GUBBINS_BRIDGE_MQTT_DISCOVERY, false, 'GUBBINS_BRIDGE_MQTT_DISCOVERY');
  const mqttDiscoveryPrefix = (env.GUBBINS_BRIDGE_MQTT_DISCOVERY_PREFIX ?? '').trim() || 'homeassistant';
  const maxPushBytes = Math.floor(
    parsePositive(
      env.GUBBINS_BRIDGE_MAX_PUSH_BYTES,
      DEFAULT_MAX_PUSH_BYTES,
      'GUBBINS_BRIDGE_MAX_PUSH_BYTES',
      {
        allowZero: false,
      },
    ),
  );

  return {
    host,
    port,
    token,
    snapshotPath,
    rateLimit,
    mdns,
    mdnsInstanceName,
    allowWrites,
    allowPush,
    maxPushBytes,
    events,
    webhooks,
    webhooksFile,
    webhooksInline,
    mqtt,
    mqttUrl,
    mqttUsername,
    mqttPassword,
    mqttPrefix,
    mqttClientId,
    mqttDiscovery,
    mqttDiscoveryPrefix,
  };
}

/**
 * Resolve the required `GUBBINS_SNAPSHOT_PATH`, throwing a clear, secret-free error when it
 * is missing. Shared by {@link loadConfig} (the HTTP server) and the MCP stdio server, which
 * needs *only* the snapshot path — its transport is the local process's own stdio, so it
 * carries no network bearer token.
 */
export function loadSnapshotPath(env: Env = process.env): string {
  const snapshotPath = (env.GUBBINS_SNAPSHOT_PATH ?? '').trim();
  if (snapshotPath.length === 0) {
    throw new Error(
      'GUBBINS_SNAPSHOT_PATH is required (the absolute path to your synced gubbins-sync.json).',
    );
  }
  return snapshotPath;
}

/** Whether `host` exposes the bridge beyond loopback (a deliberate, documented choice). */
export function isLanExposed(host: string): boolean {
  return host !== DEFAULT_HOST && host !== 'localhost' && host !== '::1';
}

/**
 * Resolve the per-IP rate-limit settings. Capacity `0` disables the limiter entirely
 * (returns `null`); otherwise both values default to the {@link createRateLimiter}
 * defaults and are validated as positive numbers.
 */
function parseRateLimit(env: Env): RateLimiterOptions | null {
  const capacity = parsePositive(
    env.GUBBINS_BRIDGE_RATE_CAPACITY,
    DEFAULT_RATE_CAPACITY,
    'GUBBINS_BRIDGE_RATE_CAPACITY',
    { allowZero: true },
  );
  if (capacity === 0) return null;

  const refillPerSec = parsePositive(
    env.GUBBINS_BRIDGE_RATE_REFILL,
    DEFAULT_RATE_REFILL_PER_SEC,
    'GUBBINS_BRIDGE_RATE_REFILL',
    { allowZero: false },
  );
  return { capacity, refillPerSec };
}

/** Parse an optional positive number, defaulting when blank and throwing on garbage. */
function parsePositive(
  raw: string | undefined,
  fallback: number,
  name: string,
  { allowZero }: { allowZero: boolean },
): number {
  const trimmed = (raw ?? '').trim();
  if (trimmed.length === 0) return fallback;

  const value = Number(trimmed);
  const floor = allowZero ? 0 : Number.EPSILON;
  if (!Number.isFinite(value) || value < floor) {
    throw new Error(`${name} must be a ${allowZero ? 'non-negative' : 'positive'} number; got "${trimmed}".`);
  }
  return value;
}

/**
 * Parse an on/off-style boolean env var. Accepts `on`/`true`/`1`/`yes` (case-insensitive)
 * as true and `off`/`false`/`0`/`no`/blank as false; anything else throws so a typo fails
 * loudly rather than silently leaving a feature off.
 */
function parseBool(raw: string | undefined, fallback: boolean, name: string): boolean {
  const trimmed = (raw ?? '').trim().toLowerCase();
  if (trimmed.length === 0) return fallback;
  if (['on', 'true', '1', 'yes'].includes(trimmed)) return true;
  if (['off', 'false', '0', 'no'].includes(trimmed)) return false;
  throw new Error(`${name} must be on/off (got "${trimmed}").`);
}

/** Parse and range-check the port, defaulting to {@link DEFAULT_PORT} when unset/blank. */
function parsePort(raw: string | undefined): number {
  const trimmed = (raw ?? '').trim();
  if (trimmed.length === 0) return DEFAULT_PORT;

  const port = Number(trimmed);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`GUBBINS_BRIDGE_PORT must be an integer in [1, 65535]; got "${trimmed}".`);
  }
  return port;
}
