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

/**
 * The **total** wall-clock budget for one logical read, so a hung HA can't tie up a bridge slot.
 *
 * A momentarily-busy Home Assistant (a restarting integration, a recorder flush) used to surface
 * as an outright failure, so a read is now attempted twice — but *within the same budget*, never
 * on top of it: an instance that is genuinely down still reports in ~5s, exactly as before.
 *
 *   attempt 1 (2 400 ms) + backoff (200 ms) + attempt 2 (2 400 ms) = 5 000 ms worst case
 *
 * Only a failure a retry can plausibly fix is retried — a timeout, a transport error, or a 5xx.
 * A rejected token (401/403) or an unknown entity (404) is deterministic and answered immediately.
 */
export const HA_REQUEST_TIMEOUT_MS = 5_000;

/** How many times one logical read is attempted, in total (not extra retries). */
export const HA_MAX_ATTEMPTS = 2;

/** A short fixed pause between attempts, so an instance mid-restart gets a moment to recover. */
export const HA_RETRY_BACKOFF_MS = 200;

/** How one logical read spends its budget: how many tries, how long each, how long between. */
export interface HaRetryPlan {
  readonly attempts: number;
  readonly attemptTimeoutMs: number;
  readonly backoffMs: number;
}

/**
 * Carve a total budget into equal per-attempt slices, leaving room for the backoff(s).
 *
 * A budget too small to hold two real attempts *plus* a backoff spends itself on one attempt
 * instead. Retrying inside it would otherwise overrun the very budget this function exists to
 * honour — two 1 ms attempts around a 200 ms pause is 202 ms of a caller's 100 ms, and the
 * attempts are too short to succeed anyway.
 */
export function haRetryPlan(totalBudgetMs: number = HA_REQUEST_TIMEOUT_MS): HaRetryPlan {
  const backoffTotal = HA_RETRY_BACKOFF_MS * (HA_MAX_ATTEMPTS - 1);
  // Each attempt must be worth at least as much as the pause between attempts, or retrying is
  // buying a wait rather than a second chance.
  if (totalBudgetMs < backoffTotal + HA_RETRY_BACKOFF_MS * HA_MAX_ATTEMPTS) {
    return { attempts: 1, attemptTimeoutMs: Math.max(1, totalBudgetMs), backoffMs: 0 };
  }
  return {
    attempts: HA_MAX_ATTEMPTS,
    attemptTimeoutMs: Math.floor((totalBudgetMs - backoffTotal) / HA_MAX_ATTEMPTS),
    backoffMs: HA_RETRY_BACKOFF_MS,
  };
}

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
  /** The **total** budget for one read, across all attempts. Defaults to `HA_REQUEST_TIMEOUT_MS`. */
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
  /**
   * A liveness check for startup: does this URL answer, and is this token accepted? It is the
   * *same* list-states read — no third endpoint and no new capability — with the payload thrown
   * away rather than projected, because the answer wanted here is only "yes" or an `HaError`.
   */
  readonly probe: () => Promise<void>;
}

/** Build a client bound to one Home Assistant instance. */
export function createHaClient(options: HaClientOptions): HaClient {
  const baseUrl = normaliseHaBaseUrl(options.baseUrl);
  const fetchImpl = options.fetchImpl ?? (globalThis.fetch as unknown as FetchLike);
  const plan = haRetryPlan(options.timeoutMs ?? HA_REQUEST_TIMEOUT_MS);

  /** One HTTP attempt. Failures come back tagged with whether trying again could plausibly help. */
  async function attempt(
    path: string,
  ): Promise<{ ok: true; body: unknown } | { ok: false; error: HaError; retryable: boolean }> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), plan.attemptTimeoutMs);
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
      // Transient by nature, so this is the case a second attempt exists for.
      return {
        ok: false,
        error: new HaError(502, 'home_assistant_unreachable', 'Could not reach Home Assistant.'),
        retryable: true,
      };
    } finally {
      clearTimeout(timer);
    }

    if (response.status === 401 || response.status === 403) {
      // Deterministic: the token is wrong now and will be wrong in 200 ms. Answer immediately.
      return {
        ok: false,
        error: new HaError(502, 'home_assistant_unauthorised', 'Home Assistant rejected the access token.'),
        retryable: false,
      };
    }
    if (response.status === 404) {
      return { ok: false, error: new HaError(404, 'not_found', 'No such entity.'), retryable: false };
    }
    if (!response.ok) {
      // A 5xx is Home Assistant itself struggling (restarting, an integration mid-reload); any
      // other 4xx is a request HA has decided about, and repeating it changes nothing.
      return {
        ok: false,
        error: new HaError(502, 'home_assistant_error', 'Home Assistant returned an error.'),
        retryable: response.status >= 500,
      };
    }

    try {
      return { ok: true, body: await response.json() };
    } catch {
      return {
        ok: false,
        error: new HaError(502, 'home_assistant_error', 'Home Assistant returned an unreadable response.'),
        retryable: false,
      };
    }
  }

  async function get(path: string): Promise<unknown> {
    for (let n = 1; ; n += 1) {
      const outcome = await attempt(path);
      if (outcome.ok) return outcome.body;
      if (!outcome.retryable || n >= plan.attempts) throw outcome.error;
      await new Promise<void>((resolve) => setTimeout(resolve, plan.backoffMs));
    }
  }

  return {
    listScaleEntities: async () => projectScaleEntities(await get('/api/states')),
    readScale: async (entityId: string) => {
      const outcome = parseScaleReading(await get(`/api/states/${encodeURIComponent(entityId)}`));
      // An entity that isn't a scale is answered exactly like a missing one — the same `404`, the
      // same message — so a token holder can't tell "exists but isn't a scale" from "doesn't
      // exist", nor read state from any entity outside the scale picker's set (issue #179).
      if (!outcome.ok && outcome.issue === 'not-a-scale') {
        throw new HaError(404, 'not_found', 'No such entity.');
      }
      return outcome;
    },
    // Deliberately the list-states read, discarded: it proves reachability *and* the token in one
    // call, and keeps the client's two-reads-only posture (nothing new is callable).
    probe: async () => void (await get('/api/states')),
  };
}
