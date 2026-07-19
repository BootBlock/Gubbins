/**
 * Ask a bridge which build it is, so the app can tell the user when theirs has fallen behind
 * (issue #282).
 *
 * The bridge reports its build in the `/api/v1` discovery index; {@link compareBridgeBuild}
 * does the judging. This module is the transport in between: **pure and transport-only**, taking
 * `fetch` as an argument and mapping the response to a result, exactly like
 * `push-to-bridge` and `features/webhooks/bridge-client`. It never throws, and no result ever
 * carries the bridge token.
 *
 * The index is behind the same bearer token as every other bridge endpoint, so this needs the
 * URL and token the user has already configured — it is a check on a connection they set up, not
 * a probe of an arbitrary host.
 */
import { normaliseBridgeBaseUrl } from '@/lib/bridge-url';
import { APP_VERSION, APP_SCHEMA_VERSION } from '@/lib/app-version';
import { compareBridgeBuild, type BridgeBuild, type BridgeVersionStatus } from './bridge-version';

/** The bridge's discovery index, appended to the user's base URL. */
export const API_INDEX_PATH = '/api/v1';

/** A minimal `fetch` shape so tests can inject a fake without the DOM lib types. */
export type FetchLike = (
  input: string,
  init: { method: string; headers: Record<string, string> },
) => Promise<{ status: number; json: () => Promise<unknown> }>;

/**
 * What the check found.
 *
 * A failure to *reach* the bridge is deliberately not modelled as a version problem — the Sync
 * screen already tells the user when the bridge is unreachable, and a second "we couldn't check
 * your version" message on top of that is noise. `ok: false` simply means "no opinion".
 */
export type BridgeBuildCheckResult =
  | {
      readonly ok: true;
      readonly status: BridgeVersionStatus;
      /** What the bridge reported, or `null` if it reported nothing usable. */
      readonly bridge: BridgeBuild | null;
      /** What this app is, so the screen can show both sides of the comparison. */
      readonly app: BridgeBuild;
    }
  | { readonly ok: false };

/** Turn a user-entered base URL into the absolute index endpoint. */
function resolveIndexUrl(baseUrl: string): string {
  const trimmed = normaliseBridgeBaseUrl(baseUrl);
  return trimmed.endsWith(API_INDEX_PATH) ? trimmed : `${trimmed}${API_INDEX_PATH}`;
}

/**
 * Whether a 200 body is recognisably the bridge's own discovery index.
 *
 * This guards a false accusation. "No `bridge` block" is read as "an old bridge", which is only
 * a fair conclusion if we are talking to a bridge at all — point the URL at an unrelated server
 * that happens to answer 200 (a router page, a reverse proxy, another service) and telling the
 * user their *bridge* is out of date sends them off fixing the wrong thing. An unrecognisable
 * body therefore yields no opinion instead.
 *
 * @internal Exported for unit tests only.
 */
export function looksLikeBridgeIndex(payload: unknown): boolean {
  if (typeof payload !== 'object' || payload === null) return false;
  const { name, openapi, endpoints } = payload as Record<string, unknown>;
  // Any one of the index's own distinctive fields is enough — a real bridge always has all
  // three, and requiring all of them would make this brittle against a future index reshuffle.
  return name === 'Gubbins Bridge API' || typeof openapi === 'string' || Array.isArray(endpoints);
}

/**
 * Read the `bridge` block out of an index payload.
 *
 * Deliberately defensive: this crosses a version boundary by definition — the whole point is
 * that the bridge may be older than us — so anything unrecognised becomes `null` ("an old
 * bridge") rather than an exception or a half-read value shown as fact.
 *
 * @internal Exported for unit tests only.
 */
export function readBridgeBuild(payload: unknown): BridgeBuild | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const block = (payload as Record<string, unknown>).bridge;
  if (typeof block !== 'object' || block === null) return null;

  const { version, schemaVersion } = block as Record<string, unknown>;
  if (typeof version !== 'string' || version.trim() === '') return null;
  if (typeof schemaVersion !== 'number' || !Number.isInteger(schemaVersion)) return null;
  return { version, schemaVersion };
}

/**
 * Ask the configured bridge which build it is and compare it against this app's.
 *
 * Returns `{ ok: false }` for anything that isn't a usable answer — unreachable, unauthorised,
 * or a body we couldn't read. A bridge that answers *without* a `bridge` block is a different
 * case and is reported as `ok: true` with status `unknown`: it answered fine, it is just old
 * enough to predate reporting its version, which is itself worth telling the user.
 */
export async function checkBridgeBuild(
  baseUrl: string,
  token: string,
  fetchImpl: FetchLike,
): Promise<BridgeBuildCheckResult> {
  const app: BridgeBuild = { version: APP_VERSION, schemaVersion: APP_SCHEMA_VERSION };

  let url: string;
  const trimmedToken = token.trim();
  try {
    url = resolveIndexUrl(baseUrl);
  } catch {
    return { ok: false };
  }
  if (trimmedToken === '') return { ok: false };

  try {
    const response = await fetchImpl(url, {
      method: 'GET',
      headers: { authorization: `Bearer ${trimmedToken}` },
    });
    if (response.status < 200 || response.status >= 300) return { ok: false };

    const payload = await response.json().catch(() => undefined);
    if (!looksLikeBridgeIndex(payload)) return { ok: false };

    const bridge = readBridgeBuild(payload);
    return { ok: true, status: compareBridgeBuild(bridge, app), bridge, app };
  } catch {
    // Network error, CORS, or the bridge is offline — never expose the raw error or the token.
    return { ok: false };
  }
}
