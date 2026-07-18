/**
 * Outbound Home Assistant REST client (issue #122) — the bridge's *inbound* data path.
 *
 * Every other Home Assistant integration in this repo is outbound: Gubbins publishes inventory
 * state *to* HA. Reading a scale is the first thing that flows the other way, and it is
 * deliberately routed through the bridge rather than done from the browser:
 *
 * - The PWA ships to an **HTTPS** origin, and a browser there cannot fetch a plain-`http`
 *   Home Assistant on the LAN (mixed content, hard-blocked). The bridge, running on the same
 *   network as HA, has no such restriction.
 * - It keeps the Home Assistant **long-lived token** in the bridge's git-ignored `.env`,
 *   alongside every other bridge secret, instead of in browser storage on a public origin.
 *
 * Like the MQTT publisher, this is an *outbound client* — it opens no port and adds no inbound
 * surface. `fetch` is injected so the whole module is testable without a network, and no
 * response is ever logged (an HA state payload describes the user's home).
 */
import {
  parseScaleReading,
  projectScaleEntities,
  type ScaleEntityDto,
  type ScaleReadingOutcome,
} from './scale.ts';
import type { ApiErrorCode } from '../api/respond.ts';

/** How long to wait on Home Assistant before giving up, so a hung HA can't tie up a bridge slot. */
export const HA_REQUEST_TIMEOUT_MS = 5_000;

/** A minimal `fetch` shape, so tests inject a fake without pulling in DOM types. */
export type FetchLike = (
  input: string,
  init: { method: string; headers: Record<string, string>; signal?: AbortSignal },
) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>;

/** Everything the client needs: where Home Assistant is, and the token to talk to it. */
export interface HaClientOptions {
  /** Base URL of the Home Assistant instance, e.g. `http://homeassistant.local:8123`. */
  readonly baseUrl: string;
  /** Long-lived access token. Never logged, never returned to a caller. */
  readonly token: string;
  readonly fetchImpl?: FetchLike;
  readonly timeoutMs?: number;
}

/**
 * A failure talking to Home Assistant, carrying the HTTP status the *bridge* should answer with
 * and a stable machine code. The message is deliberately generic: it is forwarded to the PWA and
 * must never carry the token, HA's own error text, or anything about the user's other entities.
 */
export class HaError extends Error {
  // Field declarations + explicit assignment, never constructor parameter properties: the bridge
  // is loaded by Node's strip-only TypeScript loader, which erases types without emitting the
  // assignment a parameter property implies — see `npm run smoke:bridge`.
  override readonly name = 'HaError';
  readonly status: number;
  /** Typed against the API's closed code union, so a new code can't slip past the error contract. */
  readonly code: ApiErrorCode;
  constructor(status: number, code: ApiErrorCode, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

/** Normalise a user-supplied base URL: strip trailing slashes so path joins stay well-formed. */
export function normaliseHaBaseUrl(baseUrl: string): string {
  return baseUrl.trim().replace(/\/+$/, '');
}

/**
 * The Home Assistant REST client. Two reads only — list the weight sensors, and read one of
 * them. It cannot call a service, so this path can never actuate anything in the user's home;
 * the token still wants to be a least-privilege one, which the README says.
 */
export interface HaClient {
  /** Every entity that looks like a scale, for the PWA's picker. */
  readonly listScaleEntities: () => Promise<ScaleEntityDto[]>;
  /** The current reading for one entity, reconciled to grams (or the reason it isn't). */
  readonly readScale: (entityId: string) => Promise<ScaleReadingOutcome>;
}

/** Build a client bound to one Home Assistant instance. */
export function createHaClient(options: HaClientOptions): HaClient {
  const baseUrl = normaliseHaBaseUrl(options.baseUrl);
  const fetchImpl = options.fetchImpl ?? (globalThis.fetch as unknown as FetchLike);
  const timeoutMs = options.timeoutMs ?? HA_REQUEST_TIMEOUT_MS;

  async function get(path: string): Promise<unknown> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response: { ok: boolean; status: number; json: () => Promise<unknown> };
    try {
      response = await fetchImpl(`${baseUrl}${path}`, {
        method: 'GET',
        headers: { authorization: `Bearer ${options.token}`, 'content-type': 'application/json' },
        signal: controller.signal,
      });
    } catch {
      // Offline, DNS failure, TLS problem or our own timeout. The underlying error is swallowed
      // rather than forwarded: it can contain the full URL, and the caller can act on none of it.
      throw new HaError(502, 'home_assistant_unreachable', 'Could not reach Home Assistant.');
    } finally {
      clearTimeout(timer);
    }

    if (response.status === 401 || response.status === 403) {
      throw new HaError(502, 'home_assistant_unauthorised', 'Home Assistant rejected the access token.');
    }
    if (response.status === 404) {
      throw new HaError(404, 'not_found', 'No such entity.');
    }
    if (!response.ok) {
      throw new HaError(502, 'home_assistant_error', 'Home Assistant returned an error.');
    }

    try {
      return await response.json();
    } catch {
      throw new HaError(502, 'home_assistant_error', 'Home Assistant returned an unreadable response.');
    }
  }

  return {
    listScaleEntities: async () => projectScaleEntities(await get('/api/states')),
    readScale: async (entityId: string) =>
      parseScaleReading(await get(`/api/states/${encodeURIComponent(entityId)}`)),
  };
}
