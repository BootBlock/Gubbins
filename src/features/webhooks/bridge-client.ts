/**
 * The PWA's transport to the bridge's webhook endpoints (webhooks plan `W7`; see
 * `docs/todo/done/webhooks_2026-07-18.md` §3.1, §5.5).
 *
 * The app configures subscriptions but never delivers them — the bridge does (§1). That leaves the
 * app two things it still needs to ask the bridge directly, because neither can ride the synced
 * snapshot:
 *
 * - **The delivery log.** The bridge is read-only over a snapshot that is swapped wholesale on
 *   every hydration, so it cannot write delivery outcomes back into the database — anything it
 *   wrote would be discarded. It keeps its own in-memory log and exposes it for reading instead.
 * - **Test-fire.** A test event has to be *sent*, which only the bridge can do.
 *
 * Shaped exactly like `features/sync/push-to-bridge` and `features/inventory/scale-reading`:
 * **pure and transport-only**, taking `fetch` as an argument, building a request and mapping a
 * response to a friendly result. Every branch returns a result rather than throwing, so the screen
 * has one place to render a failure, and **no message ever carries the bridge token**.
 *
 * ## Why failures are reasons, not sentences
 *
 * The bridge is a Node server with no notion of the user's language, so its own error prose cannot
 * be translated. What it does supply is a stable HTTP status, which is what this module maps onto
 * the {@link WebhookBridgeFailure} union; the React layer turns the reason into a translated string
 * via `t()`. That keeps every user-facing message inside the i18n seam while still saying something
 * specific enough to act on — the difference between "webhooks are off on your bridge" and "this
 * subscription hasn't reached your bridge yet" is the difference between two entirely different
 * fixes.
 */
import { resolveBridgeUrl } from '@/lib/bridge-url';
import { withTimeout } from '@/lib/fetch-timeout';

/** The bridge's webhook endpoints, appended to the user's configured base URL. */
export const WEBHOOK_DELIVERIES_PATH = '/api/v1/webhooks/deliveries';
export const WEBHOOK_TEST_PATH = '/api/v1/webhooks/test';

/** How many delivery rows one poll asks for. The bridge clamps its own hard maximum below this. */
export const WEBHOOK_DELIVERIES_PAGE = 50;

/** A minimal `fetch` shape so tests can inject a fake without the DOM lib types. */
export type FetchLike = (
  input: string,
  init: { method: string; headers: Record<string, string>; body?: string; signal?: AbortSignal },
) => Promise<{ status: number; json: () => Promise<unknown> }>;

/** Where the bridge is and how to authenticate — both already-configured device preferences. */
export interface BridgeConnection {
  readonly baseUrl: string;
  readonly token: string;
  readonly fetchImpl: FetchLike;
}

/**
 * Why a webhook call to the bridge failed, as a **machine-readable reason rather than a sentence**.
 *
 * `not-enabled` and `not-synced` are deliberately separate: the first means the operator has not
 * set `GUBBINS_BRIDGE_WEBHOOKS`, the second means the subscription exists in the app but the bridge
 * has not hydrated it yet (§3.1's latency). Collapsing them would leave a user restarting their
 * bridge when all they had to do was wait for the next sync.
 */
export type WebhookBridgeFailure =
  /** The bridge rejected our token. */
  | 'unauthorised'
  /** This bridge has webhooks switched off entirely (a 404 on the webhook paths). */
  | 'not-enabled'
  /** The bridge itself was unreachable (offline, wrong URL, CORS, or no bridge configured). */
  | 'bridge-unreachable'
  /** The bridge is rate-limiting us. */
  | 'rate-limited'
  /** The bridge has no such subscription — it has not reached the bridge on a sync yet. */
  | 'not-synced'
  /** The bridge answered, but not with anything we could read. */
  | 'bad-response';

/** One recorded delivery attempt-sequence. Mirrors the bridge's `WebhookDeliveryRecord`. */
export interface WebhookDelivery {
  readonly seq: number;
  readonly at: number;
  readonly targetId: string;
  readonly targetName: string;
  readonly source: 'database' | 'config';
  /** Origin + path only — the bridge never logs a query string, which a `GET` fills with payload. */
  readonly url: string;
  readonly method: string;
  readonly eventId: string;
  readonly eventType: string;
  readonly outcome: WebhookDeliveryOutcome;
  readonly attempts: number;
  readonly status: number | null;
  readonly detail: string | null;
}

/**
 * What became of a delivery.
 *
 * `blocked` is the one worth explaining in the UI rather than showing raw: it covers both the SSRF
 * guard refusing a private destination (§6.2 — the *expected* case for a LAN receiver, and a
 * configuration step rather than an error) and an unresolvable `secret_ref`, where the bridge drops
 * the subscription rather than delivering it unsigned (§6.1).
 */
export type WebhookDeliveryOutcome = 'delivered' | 'failed' | 'blocked' | 'skipped';

/** A page of the delivery log, plus the cursor a poller passes back as `since`. */
export type WebhookDeliveriesResult =
  | {
      readonly ok: true;
      readonly deliveries: readonly WebhookDelivery[];
      readonly latestSeq: number;
      /**
       * Which log instance answered — a fresh value after every bridge restart, or `null` from a
       * bridge too old to report one. The log is in bridge memory and its sequence numbers count
       * from zero again on each start, so this is what lets a poller tell "nothing new" apart from
       * "the numbering restarted underneath me".
       */
      readonly logId: string | null;
    }
  | { readonly ok: false; readonly failure: WebhookBridgeFailure };

/**
 * What a test-fire did. `unmatched` is not a failure: it means the subscription's own filter
 * excluded the synthetic event, which is a true and useful answer — the matcher ran and said no.
 */
export type WebhookTestOutcome = WebhookDeliveryOutcome | 'unmatched';

export type WebhookTestResult =
  | {
      readonly ok: true;
      readonly outcome: WebhookTestOutcome;
      readonly status: number | null;
      readonly attempts: number;
      readonly detail: string | null;
      /** The delivery-log row this wrote, or `null` when nothing was sent (`unmatched`). */
      readonly seq: number | null;
    }
  | { readonly ok: false; readonly failure: WebhookBridgeFailure };

/**
 * Build a request to the bridge. Throws on a blank URL/token, validated before any network.
 *
 * @internal Exported for unit tests only.
 */
export function buildWebhookRequest(
  baseUrl: string,
  token: string,
  path: string,
): { readonly url: string; readonly headers: Readonly<Record<string, string>> } {
  const url = resolveBridgeUrl(baseUrl, path);
  const trimmedToken = token.trim();
  if (trimmedToken === '') throw new Error('Enter the bridge access token.');
  return { url, headers: { authorization: `Bearer ${trimmedToken}` } };
}

/** Perform a call against the bridge, returning the status and parsed body, or a transport failure. */
async function callBridge(
  connection: BridgeConnection,
  path: string,
  init?: { readonly method: string; readonly body: unknown },
): Promise<{ ok: true; status: number; payload: unknown } | { ok: false; failure: WebhookBridgeFailure }> {
  let request: ReturnType<typeof buildWebhookRequest>;
  try {
    request = buildWebhookRequest(connection.baseUrl, connection.token, path);
  } catch {
    // A blank/malformed URL or token is indistinguishable, from here, from a bridge we cannot
    // reach — and the fix is the same screen either way.
    return { ok: false, failure: 'bridge-unreachable' };
  }

  try {
    const response = await connection.fetchImpl(
      request.url,
      withTimeout(
        {
          method: init?.method ?? 'GET',
          headers: {
            ...request.headers,
            ...(init === undefined ? {} : { 'content-type': 'application/json' }),
          },
          ...(init === undefined ? {} : { body: JSON.stringify(init.body) }),
        },
        'bridge',
      ),
    );
    return {
      ok: true,
      status: response.status,
      payload: await response.json().catch(() => undefined),
    };
  } catch {
    // Network error, CORS, or the bridge is offline — never expose the raw error or the token.
    return { ok: false, failure: 'bridge-unreachable' };
  }
}

/**
 * Map a non-2xx bridge response to a {@link WebhookBridgeFailure}.
 *
 * @internal Exported for unit tests only.
 */
export function mapWebhookFailure(status: number): WebhookBridgeFailure {
  if (status === 401 || status === 403) return 'unauthorised';
  // The bridge makes an absent capability invisible rather than explaining it, so a 404 on these
  // paths means "webhooks are switched off here" — not "wrong URL".
  if (status === 404) return 'not-enabled';
  if (status === 422) return 'not-synced';
  if (status === 429) return 'rate-limited';
  if (status >= 500) return 'bridge-unreachable';
  return 'bad-response';
}

/**
 * Read the delivery log, newest first.
 *
 * `since` is the highest `seq` already seen, so a poll returns **only what is new** — which is what
 * makes polling this cheap enough to do while the screen is open. Pass `undefined` for the first
 * read.
 */
export async function fetchWebhookDeliveries(
  connection: BridgeConnection,
  since?: number,
): Promise<WebhookDeliveriesResult> {
  const query = new URLSearchParams({ limit: String(WEBHOOK_DELIVERIES_PAGE) });
  if (since !== undefined) query.set('since', String(since));

  const response = await callBridge(connection, `${WEBHOOK_DELIVERIES_PATH}?${query.toString()}`);
  if (!response.ok) return response;
  if (response.status < 200 || response.status >= 300) {
    return { ok: false, failure: mapWebhookFailure(response.status) };
  }

  const deliveries = readDeliveries(response.payload);
  const latestSeq = readNumber(response.payload, 'latestSeq');
  if (deliveries === null || latestSeq === null) return { ok: false, failure: 'bad-response' };
  // `logId` is read leniently rather than required: a bridge predating it is otherwise perfectly
  // able to answer this call, and the poller has a (weaker) fallback for that case.
  return { ok: true, deliveries, latestSeq, logId: readString(response.payload, 'logId') };
}

/**
 * Fire a synthetic event at one subscription, through the bridge's real matcher, template, SSRF
 * guard and delivery path (§5.5). The result is also written to the delivery log, so the next poll
 * shows it in context alongside real traffic.
 */
export async function sendWebhookTestEvent(
  connection: BridgeConnection,
  subscriptionId: string,
): Promise<WebhookTestResult> {
  const trimmed = subscriptionId.trim();
  if (trimmed === '') return { ok: false, failure: 'bad-response' };

  const response = await callBridge(connection, WEBHOOK_TEST_PATH, {
    method: 'POST',
    body: { subscriptionId: trimmed },
  });
  if (!response.ok) return response;
  if (response.status < 200 || response.status >= 300) {
    return { ok: false, failure: mapWebhookFailure(response.status) };
  }

  const outcome = readTestOutcome(response.payload);
  if (outcome === null) return { ok: false, failure: 'bad-response' };
  return {
    ok: true,
    outcome,
    status: readNumber(response.payload, 'status'),
    attempts: readNumber(response.payload, 'attempts') ?? 0,
    detail: readString(response.payload, 'detail'),
    seq: readNumber(response.payload, 'seq'),
  };
}

// --- Response readers -------------------------------------------------------------
//
// Deliberately defensive: this payload crosses a version boundary (an older or newer bridge may
// answer), so a shape we do not recognise becomes `bad-response` rather than an exception or a
// half-populated row rendered as fact.

const DELIVERY_OUTCOMES: readonly string[] = ['delivered', 'failed', 'blocked', 'skipped'];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function readNumber(payload: unknown, key: string): number | null {
  if (!isRecord(payload)) return null;
  const value = payload[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function readString(payload: unknown, key: string): string | null {
  if (!isRecord(payload)) return null;
  const value = payload[key];
  return typeof value === 'string' ? value : null;
}

function readTestOutcome(payload: unknown): WebhookTestOutcome | null {
  const outcome = readString(payload, 'outcome');
  if (outcome === null) return null;
  if (outcome === 'unmatched' || DELIVERY_OUTCOMES.includes(outcome)) {
    return outcome as WebhookTestOutcome;
  }
  return null;
}

function readDeliveries(payload: unknown): readonly WebhookDelivery[] | null {
  if (!isRecord(payload)) return null;
  const raw = payload.deliveries;
  if (!Array.isArray(raw)) return null;

  const deliveries: WebhookDelivery[] = [];
  for (const entry of raw) {
    const delivery = readDelivery(entry);
    // One unreadable row does not invalidate the page — skip it rather than blanking the log.
    if (delivery !== null) deliveries.push(delivery);
  }
  return deliveries;
}

function readDelivery(entry: unknown): WebhookDelivery | null {
  if (!isRecord(entry)) return null;

  const seq = readNumber(entry, 'seq');
  const at = readNumber(entry, 'at');
  const outcome = readString(entry, 'outcome');
  const eventType = readString(entry, 'eventType');
  if (seq === null || at === null || outcome === null || eventType === null) return null;
  if (!DELIVERY_OUTCOMES.includes(outcome)) return null;

  const source = readString(entry, 'source');
  return {
    seq,
    at,
    targetId: readString(entry, 'targetId') ?? '',
    targetName: readString(entry, 'targetName') ?? '',
    source: source === 'config' ? 'config' : 'database',
    url: readString(entry, 'url') ?? '',
    method: readString(entry, 'method') ?? '',
    eventId: readString(entry, 'eventId') ?? '',
    eventType,
    outcome: outcome as WebhookDeliveryOutcome,
    attempts: readNumber(entry, 'attempts') ?? 0,
    status: readNumber(entry, 'status'),
    detail: readString(entry, 'detail'),
  };
}
