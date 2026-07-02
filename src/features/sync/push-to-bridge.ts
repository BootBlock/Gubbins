/**
 * "Push to bridge" — hand the dataset straight to the optional Home Assistant query bridge
 * over HTTP (Deferred-work: PWA push to bridge).
 *
 * The bridge (in `bridge/`) normally *reads* the `gubbins-sync.json` snapshot the FS-Access sync
 * writes to a shared folder. A user who doesn't use folder sync — no NAS, no synced drive — can
 * instead POST the snapshot directly to the bridge's opt-in `POST /api/v1/snapshot` endpoint. The
 * bridge validates it with the same version guard and re-hydrates it, so the data it serves is
 * byte-identical to what it would have read from a synced file.
 *
 * The payload is built with the **same** {@link snapshotToBackupJson}/{@link buildLocalSnapshot}
 * the folder sync and "Download backup" use — never a hand-rolled shape — so the bytes the bridge
 * ingests match the bytes the watcher reads. This module is **pure and transport-only**: it builds
 * the request and maps the response to a friendly result; the React screen supplies the driver,
 * the configured URL/token, and the real `fetch`. It imports **nothing** from `bridge/` (no bundle
 * bloat).
 */
import type { IDatabaseDriver } from '@/db/rpc/driver';
import { buildLocalSnapshot } from './snapshot';
import { snapshotToBackupJson } from './backup';

/** The bridge's versioned snapshot-ingest path, appended to the user's base URL. */
export const SNAPSHOT_INGEST_PATH = '/api/v1/snapshot';

/**
 * Serialise the whole local dataset to the exact versioned-JSON the bridge ingests — the same
 * bytes the FS-Access sync writes to a folder and "Download backup" saves. `now` is injectable
 * for deterministic tests.
 */
export async function buildPushSnapshotJson(
  driver: IDatabaseDriver,
  now: number = Date.now(),
): Promise<string> {
  return snapshotToBackupJson(await buildLocalSnapshot(driver, now));
}

/**
 * Turn a user-entered bridge base URL into the absolute ingest endpoint. Trailing slashes are
 * tolerated, and a URL that already ends in the ingest path is respected (so pasting either the
 * base or the full endpoint works). Throws a friendly error on a blank or non-HTTP(S) URL.
 */
export function resolveBridgeIngestUrl(baseUrl: string): string {
  const trimmed = baseUrl.trim().replace(/\/+$/, '');
  if (trimmed === '') throw new Error('Enter the bridge URL, e.g. http://127.0.0.1:8787.');
  if (!/^https?:\/\//i.test(trimmed)) {
    throw new Error('The bridge URL must start with http:// or https://.');
  }
  return trimmed.endsWith(SNAPSHOT_INGEST_PATH) ? trimmed : `${trimmed}${SNAPSHOT_INGEST_PATH}`;
}

/** The shaped HTTP request a push makes — split out so it can be unit-tested without a network. */
export interface PushRequestShape {
  readonly url: string;
  readonly method: 'POST';
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
}

/**
 * Build the POST request for a push: resolve the endpoint, attach the bearer token, and send the
 * snapshot JSON. Throws a friendly error on a blank URL or token (validated before any network).
 */
export function buildPushRequest(baseUrl: string, token: string, json: string): PushRequestShape {
  const url = resolveBridgeIngestUrl(baseUrl);
  const trimmedToken = token.trim();
  if (trimmedToken === '') throw new Error('Enter the bridge access token.');
  return {
    url,
    method: 'POST',
    headers: { authorization: `Bearer ${trimmedToken}`, 'content-type': 'application/json' },
    body: json,
  };
}

/** The outcome of a push, ready to surface in the UI. */
export interface PushResult {
  readonly ok: boolean;
  readonly message: string;
}

/** A minimal `fetch` shape so tests can inject a fake without the DOM lib types. */
export type FetchLike = (
  input: string,
  init: { method: string; headers: Record<string, string>; body: string },
) => Promise<{ status: number; json: () => Promise<unknown> }>;

/**
 * POST the snapshot JSON to the configured bridge and map the response to a friendly,
 * token-free {@link PushResult}. Every branch returns a result rather than throwing, so the UI
 * has one place to render success/failure. A bad URL/token (caught before the request) and a
 * network failure both surface as a clear, non-leaking message.
 */
export async function pushSnapshotToBridge(options: {
  readonly baseUrl: string;
  readonly token: string;
  readonly json: string;
  readonly fetchImpl: FetchLike;
}): Promise<PushResult> {
  let request: PushRequestShape;
  try {
    request = buildPushRequest(options.baseUrl, options.token, options.json);
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : 'Invalid bridge settings.' };
  }

  let status: number;
  let payload: unknown;
  try {
    const response = await options.fetchImpl(request.url, {
      method: request.method,
      headers: { ...request.headers },
      body: request.body,
    });
    status = response.status;
    payload = await response.json().catch(() => undefined);
  } catch {
    // Network error, CORS, or the bridge is offline — never expose the raw error/token.
    return {
      ok: false,
      message: `Could not reach the bridge at ${request.url}. Check it is running and the URL is correct.`,
    };
  }

  return mapPushResponse(status, payload, request.url);
}

/** Map an HTTP status (+ the bridge's error envelope, when present) to a friendly result. */
export function mapPushResponse(status: number, payload: unknown, url: string): PushResult {
  if (status >= 200 && status < 300) {
    const formatVersion = readNumber(payload, 'formatVersion');
    return {
      ok: true,
      message:
        formatVersion !== null
          ? `Snapshot pushed to the bridge (format ${formatVersion}). It will serve the new data shortly.`
          : 'Snapshot pushed to the bridge. It will serve the new data shortly.',
    };
  }

  const bridgeMessage = readErrorMessage(payload);
  switch (status) {
    case 401:
      return {
        ok: false,
        message: 'The bridge rejected the access token. Check it matches GUBBINS_BRIDGE_TOKEN.',
      };
    case 404:
      return {
        ok: false,
        message:
          'This bridge does not accept pushes. Enable it with GUBBINS_BRIDGE_ALLOW_PUSH=on (a JSON snapshot source is required), then try again.',
      };
    case 413:
      return {
        ok: false,
        message:
          bridgeMessage ??
          'The snapshot is larger than the bridge allows. Raise GUBBINS_BRIDGE_MAX_PUSH_BYTES on the bridge.',
      };
    case 422:
      return {
        ok: false,
        message:
          bridgeMessage ??
          'The bridge could not accept this snapshot. It may be running an older Gubbins build.',
      };
    case 429:
      return { ok: false, message: 'The bridge is rate-limiting requests. Wait a moment and try again.' };
    default:
      return {
        ok: false,
        message: bridgeMessage ?? `The bridge returned an unexpected error (HTTP ${status}) from ${url}.`,
      };
  }
}

/** Read the bridge's structured `{ error: { code, message } }` message, if present. */
function readErrorMessage(payload: unknown): string | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const error = (payload as { error?: unknown }).error;
  if (typeof error !== 'object' || error === null) return null;
  const message = (error as { message?: unknown }).message;
  return typeof message === 'string' && message.length > 0 ? message : null;
}

function readNumber(payload: unknown, key: string): number | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const value = (payload as Record<string, unknown>)[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}
