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
 */
import {
  DEFAULT_RATE_CAPACITY,
  DEFAULT_RATE_REFILL_PER_SEC,
  type RateLimiterOptions,
} from './rate-limit.ts';

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
    throw new Error(
      'GUBBINS_BRIDGE_TOKEN is required (set it in a git-ignored .env — see .env.example).',
    );
  }

  const snapshotPath = loadSnapshotPath(env);

  const host = (env.GUBBINS_BRIDGE_HOST ?? '').trim() || DEFAULT_HOST;
  const port = parsePort(env.GUBBINS_BRIDGE_PORT);
  const rateLimit = parseRateLimit(env);
  const mdns = parseBool(env.GUBBINS_BRIDGE_MDNS, false, 'GUBBINS_BRIDGE_MDNS');
  const mdnsInstanceName = (env.GUBBINS_BRIDGE_MDNS_NAME ?? '').trim() || undefined;
  const allowWrites = parseBool(env.GUBBINS_BRIDGE_ALLOW_WRITES, false, 'GUBBINS_BRIDGE_ALLOW_WRITES');
  const allowPush = parseBool(env.GUBBINS_BRIDGE_ALLOW_PUSH, false, 'GUBBINS_BRIDGE_ALLOW_PUSH');
  const maxPushBytes = Math.floor(
    parsePositive(env.GUBBINS_BRIDGE_MAX_PUSH_BYTES, DEFAULT_MAX_PUSH_BYTES, 'GUBBINS_BRIDGE_MAX_PUSH_BYTES', {
      allowZero: false,
    }),
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
    throw new Error(
      `${name} must be a ${allowZero ? 'non-negative' : 'positive'} number; got "${trimmed}".`,
    );
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
