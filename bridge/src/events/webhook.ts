/**
 * Outbound webhook delivery — opt-in (`GUBBINS_BRIDGE_WEBHOOKS=on`), off by default.
 *
 * Originally EI-1 (one operator-configured target, always a signed `POST` of the event envelope).
 * The webhooks plan `W5` extends it into the delivery half of issue #87: the *app* configures
 * subscriptions and the **bridge** is the sole deliverer (see `docs/todo/done/webhooks_2026-07-18.md`
 * §1, §7). The retry/backoff/circuit/queue machinery below is EI-1's, unchanged in behaviour —
 * what grew is the target model and the request builder.
 *
 * ## What a delivery now involves
 *
 * A target may specify its own HTTP **method** (the issue explicitly asks for more than `POST`),
 * extra static **headers**, a payload **template** or preset, a declarative **filter**, and it may
 * be **unsigned** (the EI-1 target required a secret). So per (event × target):
 *
 *   1. The event is projected to a closed `WebhookEventView` (`webhook-view.ts`) — the allow-list
 *      the `W3` modules read.
 *   2. `subscriptionMatches` decides delivery: enabled, then event type, then filter. One rule, in
 *      `src/`, shared with the app's `W7` preview so the two can never disagree.
 *   3. `resolveWebhookPayload` decides the body: the default envelope (the event serialised
 *      **unchanged**, so every EI-1 receiver keeps working byte-for-byte), a preset, or a rendered
 *      template.
 *   4. The **SSRF guard** (`webhook-ssrf.ts`, §6.2) decides whether the destination may be reached
 *      at all. This is the feature's primary security control, so it sits in the request path
 *      rather than at config time — a subscription's URL arrives over sync and is never trusted.
 *      Because the guard classifies *one* address, the delivery must reach that address and no
 *      other: redirects are **not** followed, and a `3xx` ends the delivery as a failure (#494).
 *   5. `GET` flattens the payload into query parameters and sends **no body** — and therefore
 *      carries **no HMAC signature**, since the signature signs a body. That is a real limitation
 *      of the method, not an oversight.
 *   6. The outcome is recorded in the bridge-side delivery log (`webhook-log.ts`), which is the
 *      only way the app can ever see what happened (§3.1).
 *
 * ## Secrets and logging
 *
 * A secret reaches this module already resolved (`webhook-targets.ts` turns a `secret_ref` into a
 * value, or drops the target). Nothing here logs a secret, a signature, a header, or a query
 * string — diagnostics use `redactUrl` (origin + path), and a `GET` delivery's query carries
 * payload data, which is exactly why it is dropped.
 *
 * Zero dependencies — `node:crypto` + the global `fetch`.
 */
import { createHmac, randomUUID } from 'node:crypto';
import type { IDatabaseDriver } from '@/db/rpc/driver';
import type { WebhookEventView } from '@/features/webhooks/event-view.ts';
import { subscriptionMatches } from '@/features/webhooks/matcher.ts';
import { resolveWebhookPayload, webhookQueryParams } from '@/features/webhooks/template.ts';
import { errorDetail, errorMessage } from '../errors.ts';
import type { BridgeEvent } from './model.ts';
import type { EventSink } from './pipeline.ts';
import { buildWebhookEventView, createWebhookViewContext } from './webhook-view.ts';
import { configTargetToDeliveryTarget, type WebhookDeliveryTarget } from './webhook-targets.ts';
import { checkWebhookDestination, type WebhookHostResolver, type WebhookSsrfPolicy } from './webhook-ssrf.ts';
import type { WebhookDeliveryLog, WebhookDeliveryOutcome } from './webhook-log.ts';

/**
 * One **operator-configured** webhook destination, from the git-ignored `webhooks.json` /
 * `GUBBINS_BRIDGE_WEBHOOKS_TARGETS`.
 *
 * Deliberately unchanged from EI-1 — this is a committed config contract, and an operator's
 * existing file must keep working. The richer per-subscription model is
 * {@link WebhookDeliveryTarget}; `configTargetToDeliveryTarget` adapts this shape into it.
 */
export interface WebhookTarget {
  /** Absolute http(s) URL to POST to. */
  readonly url: string;
  /** Shared secret used to HMAC-sign each body. Never logged. */
  readonly secret: string;
  /**
   * Event types this target wants (e.g. `["item.low_stock"]`). Omitted/empty = every event.
   * A `*` entry also means "all".
   */
  readonly events?: readonly string[];
}

/** Header names (the `X-Gubbins-*` family), exported so a consumer/test verifies against them. */
export const SIGNATURE_HEADER = 'X-Gubbins-Signature';
export const DELIVERY_HEADER = 'X-Gubbins-Delivery';
export const EVENT_TYPE_HEADER = 'X-Gubbins-Event';

/** Default max delivery attempts (1 initial + retries) before a target's circuit counts a failure. */
export const DEFAULT_MAX_ATTEMPTS = 5;
/** Default base backoff (ms); the nth retry waits `base * 2^(n-1)`, capped at {@link DEFAULT_MAX_BACKOFF_MS}. */
export const DEFAULT_BASE_BACKOFF_MS = 500;
/** Default cap on a single backoff wait. */
export const DEFAULT_MAX_BACKOFF_MS = 30_000;
/** Consecutive failed deliveries that trip a target's circuit open. */
export const DEFAULT_CIRCUIT_THRESHOLD = 5;
/** How long a tripped circuit stays open before the target is retried. */
export const DEFAULT_CIRCUIT_COOLDOWN_MS = 60_000;
/** Hard cap on a single target's pending queue; excess is dropped (logged) rather than unbounded. */
export const DEFAULT_MAX_QUEUE = 1_000;

/**
 * A minimal fetch shape so tests can inject a fake without pulling in DOM lib types.
 *
 * `body` is **optional**: a `GET` delivery carries its payload in the query string and sends none.
 * The response's `body` is likewise optional — a receiver's error text is recorded (truncated) in
 * the delivery log when available, and its absence is not a failure.
 *
 * **Contract: an implementation must not follow redirects.** A `3xx` is returned as-is, with its
 * status, so the caller can refuse it — following one would re-issue the request at an address the
 * SSRF guard never classified.
 */
export type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; body?: string },
) => Promise<{ ok: boolean; status: number; body?: string }>;

/**
 * Resolve the current target list. Called once per event batch, so a subscription added in the app
 * and synced to the bridge becomes live on the next generation without a restart.
 *
 * `driver` is the just-swapped generation's driver, absent for a batch with no generation behind it
 * (the read-triggered `lookup.resolved` path).
 */
export type WebhookTargetResolver = (driver?: IDatabaseDriver) => Promise<readonly WebhookDeliveryTarget[]>;

export interface WebhookDelivererOptions {
  /**
   * Operator-configured targets (the EI-1 shape). Merged with whatever {@link resolveTargets}
   * returns; supply either, both, or neither.
   */
  readonly targets?: readonly WebhookTarget[];
  /**
   * Dynamic target source — in practice the app's `webhooks` table, read from the hydrated DB.
   * Absent means the static {@link targets} are the whole list.
   */
  readonly resolveTargets?: WebhookTargetResolver;
  /** Injectable transport (defaults to the global `fetch`). */
  readonly fetchImpl?: FetchLike;
  /** Injectable delay (defaults to a real `setTimeout` sleep). */
  readonly sleep?: (ms: number) => Promise<void>;
  /** Injectable delivery-id generator (defaults to `crypto.randomUUID`). */
  readonly newDeliveryId?: () => string;
  readonly maxAttempts?: number;
  readonly baseBackoffMs?: number;
  readonly maxBackoffMs?: number;
  readonly circuitThreshold?: number;
  readonly circuitCooldownMs?: number;
  readonly maxQueue?: number;
  /** Injectable clock for the circuit cooldown (defaults to `Date.now`). */
  readonly now?: () => number;
  /** Optional log sink for delivery diagnostics (defaults to `console.warn`). Never receives secrets. */
  readonly log?: (message: string) => void;
  /**
   * The SSRF policy (§6.2). Defaults to the safe posture — private/loopback destinations refused —
   * so a caller that forgets to pass one gets the guard, not a hole.
   */
  readonly ssrfPolicy?: WebhookSsrfPolicy;
  /** Injectable DNS resolver for the SSRF guard, so tests never touch the network. */
  readonly hostResolver?: WebhookHostResolver;
  /** The bridge-side delivery log the `/api/v1/webhooks/deliveries` endpoint reads. */
  readonly deliveryLog?: WebhookDeliveryLog;
}

export interface WebhookDeliverer extends EventSink {
  /** Resolve once every target's queue has drained (for tests / graceful shutdown). */
  whenIdle(): Promise<void>;
}

/** Compute the `sha256=<hex>` signature of `body` under `secret` (HMAC-SHA256). */
export function signBody(secret: string, body: string): string {
  return `sha256=${createHmac('sha256', secret).update(body, 'utf8').digest('hex')}`;
}

/** Whether a target wants an event of this type (no filter, empty, or `*` = all). */
export function targetWantsType(target: WebhookTarget, type: string): boolean {
  const filter = target.events;
  if (filter === undefined || filter.length === 0) return true;
  return filter.includes('*') || filter.includes(type);
}

/**
 * Validate an untrusted value (parsed JSON from the targets file / env var) into a
 * {@link WebhookTarget} list, throwing a clear, **secret-free** error on a bad shape. Accepts
 * either a bare array of targets or a `{ "targets": [...] }` wrapper. An empty list is valid
 * (webhooks enabled but nothing configured yet).
 */
export function parseWebhookTargets(value: unknown): WebhookTarget[] {
  const list = Array.isArray(value)
    ? value
    : isRecord(value) && Array.isArray(value.targets)
      ? value.targets
      : null;
  if (list === null) {
    throw new Error('Webhook targets must be a JSON array (or a { "targets": [...] } object).');
  }
  return list.map((raw, index) => parseTarget(raw, index));
}

function parseTarget(raw: unknown, index: number): WebhookTarget {
  if (!isRecord(raw)) throw new Error(`Webhook target #${index + 1} must be an object.`);
  const { url, secret, events } = raw;
  if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) {
    throw new Error(`Webhook target #${index + 1} needs an http(s) "url".`);
  }
  if (typeof secret !== 'string' || secret.length === 0) {
    throw new Error(`Webhook target #${index + 1} needs a non-empty "secret".`);
  }
  if (events !== undefined) {
    if (!Array.isArray(events) || events.some((e) => typeof e !== 'string')) {
      throw new Error(`Webhook target #${index + 1} "events", when present, must be an array of strings.`);
    }
  }
  return {
    url,
    secret,
    ...(events !== undefined ? { events: events as string[] } : {}),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * The concrete HTTP request a delivery will issue — built purely, so it is directly testable and
 * so "what goes on the wire?" has one answer rather than being smeared through the retry loop.
 */
export interface WebhookRequestPlan {
  readonly url: string;
  readonly method: string;
  readonly headers: Record<string, string>;
  /** Absent for `GET` (whose payload rides the query string). */
  readonly body?: string;
}

/**
 * Build the request for one (target × event).
 *
 * Header precedence is deliberate and one-directional: the subscription's static headers go on
 * **first**, then the deliverer's own (`content-type`, the `X-Gubbins-*` family) overwrite them.
 * A subscription therefore cannot forge its own signature or delivery id even if the header
 * sanitiser in `webhook-targets.ts` were bypassed — two independent guards on the same property,
 * because it is the one that matters.
 */
export function buildWebhookRequest(
  target: WebhookDeliveryTarget,
  event: BridgeEvent,
  view: WebhookEventView,
  deliveryId: string,
): WebhookRequestPlan {
  const payload = resolveWebhookPayload(target.template, view);
  const headers: Record<string, string> = { ...(target.headers ?? {}) };

  if (target.method === 'GET') {
    // No body, so no signature: an HMAC signs a body, and there isn't one. The UI says so (§5.3).
    const url = new URL(target.url);
    for (const [name, value] of webhookQueryParams(payload, view)) {
      url.searchParams.set(name, value);
    }
    headers[DELIVERY_HEADER] = deliveryId;
    headers[EVENT_TYPE_HEADER] = event.type;
    return { url: url.href, method: 'GET', headers };
  }

  // `envelope` sends the original event object unchanged — the EI-1 contract, byte-for-byte.
  const body =
    payload.kind === 'envelope'
      ? JSON.stringify(event)
      : payload.kind === 'json'
        ? JSON.stringify(payload.body)
        : payload.body;

  headers['content-type'] =
    payload.kind === 'text' ? 'text/plain; charset=utf-8' : 'application/json; charset=utf-8';
  if (target.secret !== null) headers[SIGNATURE_HEADER] = signBody(target.secret, body);
  headers[DELIVERY_HEADER] = deliveryId;
  headers[EVENT_TYPE_HEADER] = event.type;

  return { url: target.url, method: target.method, headers, body };
}

/** One queued unit of work: a matched (target × event) pair with its already-built view. */
interface WebhookJob {
  readonly target: WebhookDeliveryTarget;
  readonly event: BridgeEvent;
  readonly view: WebhookEventView;
}

/**
 * Create the deliverer. Each target gets its own ordered queue + circuit; targets never block each
 * other, and a target's circuit state survives across generations (it is keyed by target id, not
 * rebuilt when the subscription list is re-read).
 */
export function createWebhookDeliverer(options: WebhookDelivererOptions): WebhookDeliverer {
  const fetchImpl = options.fetchImpl ?? defaultFetch;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const newDeliveryId = options.newDeliveryId ?? (() => randomUUID());
  const now = options.now ?? Date.now;
  const log = options.log ?? ((m: string) => console.warn(m));
  const maxAttempts = Math.max(1, options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS);
  const baseBackoff = Math.max(0, options.baseBackoffMs ?? DEFAULT_BASE_BACKOFF_MS);
  const maxBackoff = Math.max(baseBackoff, options.maxBackoffMs ?? DEFAULT_MAX_BACKOFF_MS);
  const circuitThreshold = Math.max(1, options.circuitThreshold ?? DEFAULT_CIRCUIT_THRESHOLD);
  const cooldown = Math.max(0, options.circuitCooldownMs ?? DEFAULT_CIRCUIT_COOLDOWN_MS);
  const maxQueue = Math.max(1, options.maxQueue ?? DEFAULT_MAX_QUEUE);
  // Default to the guarded posture: a caller that omits the policy gets the protection, not a hole.
  const ssrfPolicy = options.ssrfPolicy ?? { allowPrivate: false };
  const deliveryLog = options.deliveryLog;

  // Adapted once, through the same seam `webhook-targets.ts` owns — there is no import cycle to
  // dodge, because that module's import of this one is type-only and therefore erased at runtime.
  const staticTargets = (options.targets ?? []).map(configTargetToDeliveryTarget);
  const workers = new Map<string, TargetWorkerShape>();
  /** Serialises the async intake so `whenIdle` can wait for enqueueing as well as draining. */
  let intake: Promise<void> = Promise.resolve();

  function workerFor(targetId: string): TargetWorkerShape {
    let worker = workers.get(targetId);
    if (worker === undefined) {
      worker = createTargetWorker();
      workers.set(targetId, worker);
    }
    return worker;
  }

  /** One target's ordered queue + retry loop + failure circuit. */
  function createTargetWorker(): TargetWorkerShape {
    const queue: WebhookJob[] = [];
    let running = false;
    let consecutiveFailures = 0;
    let circuitOpenUntil = 0;
    let idleWaiters: Array<() => void> = [];

    async function drain(): Promise<void> {
      running = true;
      try {
        while (queue.length > 0) {
          const job = queue.shift()!;
          if (now() < circuitOpenUntil) {
            log(`Webhook target skipped (circuit open): ${redactUrl(job.target.url)}`);
            recordOutcome(job, 'skipped', 0, null, 'The target failure circuit is open.');
            continue;
          }
          const result = await deliverWithRetry(job);
          // A refusal leaves the counter exactly as it was: it is neither evidence the endpoint is
          // healthy (so it must not reset) nor evidence it is failing (so it must not increment).
          if (result === 'blocked') continue;
          if (result === 'delivered') {
            consecutiveFailures = 0;
          } else if (++consecutiveFailures >= circuitThreshold) {
            circuitOpenUntil = now() + cooldown;
            log(
              `Webhook target circuit opened after ${consecutiveFailures} failures: ${redactUrl(job.target.url)}`,
            );
          }
        }
      } finally {
        running = false;
        const waiters = idleWaiters;
        idleWaiters = [];
        for (const resolve of waiters) resolve();
      }
    }

    /**
     * Issue one job, retrying with bounded exponential backoff.
     *
     * The SSRF check runs **inside** here, once per job rather than once per target list, because a
     * hostname's resolution can change and the check is what stands between a synced subscription
     * and the operator's LAN. A refusal is terminal for the job — it is not a transient failure, so
     * retrying it would only repeat the same verdict — and it is reported as `blocked` rather than
     * `failed` so the UI can say *why* nothing was sent, and so the caller can leave the failure
     * circuit alone (see the call site).
     */
    async function deliverWithRetry(job: WebhookJob): Promise<'delivered' | 'failed' | 'blocked'> {
      const verdict = await checkWebhookDestination(job.target.url, ssrfPolicy, options.hostResolver);
      if (!verdict.allowed) {
        log(
          `Webhook delivery refused for ${redactUrl(job.target.url)}: ${verdict.reason}. ` +
            'Set GUBBINS_BRIDGE_WEBHOOKS_ALLOW_PRIVATE=on to allow private/loopback destinations.',
        );
        recordOutcome(job, 'blocked', 0, null, `Refused: ${verdict.reason}.`);
        return 'blocked';
      }

      const plan = buildWebhookRequest(job.target, job.event, job.view, newDeliveryId());
      let lastStatus: number | null = null;
      let lastDetail: string | null = null;

      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
          const res = await fetchImpl(plan.url, {
            method: plan.method,
            headers: { ...plan.headers },
            ...(plan.body !== undefined ? { body: plan.body } : {}),
          });
          lastStatus = res.status;
          if (res.ok) {
            recordOutcome(job, 'delivered', attempt, res.status, null);
            return 'delivered';
          }
          if (isRedirect(res.status)) {
            // The guard classified *this* URL's address; the redirect names another one it never
            // saw, so following it would hand a synced subscription the LAN reach the guard exists
            // to withhold (#494). Terminal, not retried: a receiver that redirects will redirect
            // again, and the detail is ours rather than the receiver's so the operator is told why.
            log(
              `Webhook delivery got HTTP ${res.status} from ${redactUrl(plan.url)}; ` +
                'redirects are not followed, so the delivery is abandoned.',
            );
            recordOutcome(job, 'failed', attempt, res.status, REDIRECT_DETAIL);
            return 'failed';
          }
          lastDetail = res.body ?? null;
          log(`Webhook delivery got HTTP ${res.status} from ${redactUrl(plan.url)} (attempt ${attempt}).`);
        } catch (err) {
          lastDetail = errorMessage(err);
          log(`Webhook delivery failed to ${redactUrl(plan.url)} (attempt ${attempt}): ${lastDetail}`);
        }
        if (attempt < maxAttempts) await sleep(backoffFor(attempt, baseBackoff, maxBackoff));
      }
      recordOutcome(job, 'failed', maxAttempts, lastStatus, lastDetail);
      return 'failed';
    }

    return {
      enqueue(job: WebhookJob): void {
        if (queue.length >= maxQueue) {
          log(`Webhook queue full for ${redactUrl(job.target.url)}; dropping an event.`);
          return;
        }
        queue.push(job);
        if (!running) void drain();
      },
      whenIdle(): Promise<void> {
        if (!running && queue.length === 0) return Promise.resolve();
        return new Promise<void>((resolve) => idleWaiters.push(resolve));
      },
    };
  }

  /** Record a finished delivery, if a log is wired. Never receives a secret, header or query. */
  function recordOutcome(
    job: WebhookJob,
    outcome: WebhookDeliveryOutcome,
    attempts: number,
    status: number | null,
    detail: string | null,
  ): void {
    deliveryLog?.record({
      targetId: job.target.id,
      targetName: job.target.name,
      source: job.target.source,
      url: redactUrl(job.target.url),
      method: job.target.method,
      eventId: job.event.id,
      eventType: job.event.type,
      outcome,
      attempts,
      status,
      detail,
    });
  }

  /**
   * Resolve the current targets, project each event once, match, and enqueue.
   *
   * The view is built **once per event** and shared by every matching target: it costs DB reads,
   * and every target sees the same event. Building it inside the awaited intake matters — the
   * watcher only lets the next reload close the driver after `onGeneration` resolves, so this is
   * the window in which the driver is guaranteed live. The network delivery that follows is
   * queued and outlives it, which is fine because it touches no driver.
   */
  async function ingest(events: readonly BridgeEvent[], driver?: IDatabaseDriver): Promise<void> {
    let resolved: readonly WebhookDeliveryTarget[] = [];
    try {
      resolved = options.resolveTargets ? await options.resolveTargets(driver) : [];
    } catch (err) {
      log(`Failed to read webhook subscriptions: ${errorDetail(err)}. Using configured targets only.`);
    }
    const targets = [...staticTargets, ...resolved];
    if (targets.length === 0) return;

    const context = driver ? createWebhookViewContext(driver) : undefined;
    for (const event of events) {
      let view: WebhookEventView;
      try {
        view = await buildWebhookEventView(event, context);
      } catch (err) {
        log(`Failed to project webhook event ${event.id}: ${errorDetail(err)}.`);
        continue;
      }
      for (const target of targets) {
        if (!subscriptionMatches(target, view)) continue;
        workerFor(target.id).enqueue({ target, event, view });
      }
    }
  }

  return {
    /**
     * The {@link EventSink} entry point. Returns the intake promise so the pipeline can await the
     * driver-touching half; the network half continues in the background.
     */
    deliver(events: readonly BridgeEvent[], driver?: IDatabaseDriver): Promise<void> {
      const pending = ingest(events, driver).catch((err: unknown) => {
        log(`Webhook intake failed: ${errorDetail(err)}.`);
      });
      // Chained so `whenIdle` waits for *every* in-flight intake, not just the latest.
      intake = intake.then(() => pending);
      return pending;
    },
    async whenIdle(): Promise<void> {
      // Intake first: until it resolves, jobs may still be being enqueued, so a worker reporting
      // "idle" would be answering about a queue that is not yet fully populated.
      await intake;
      await Promise.all([...workers.values()].map((w) => w.whenIdle()));
    },
  };

  /**
   * The default transport: the global `fetch`, narrowed to {@link FetchLike}.
   *
   * `redirect: 'manual'` is the security-relevant part. `fetch` defaults to `'follow'`, and a
   * `307`/`308` preserves the method **and** the body — so a receiver the SSRF guard allowed could
   * answer with `Location: http://169.254.169.254/…` and have the bridge issue, in full, the very
   * request the guard had just refused (#494). Manual mode returns the `3xx` itself, which
   * `deliverWithRetry` ends the delivery on.
   *
   * The body is read through a byte cap for the same reason it is read at all: only a short
   * diagnostic is ever kept, so an unbounded read would let a hostile or broken receiver make the
   * bridge buffer an arbitrary amount of memory — once per attempt — on a Pi-class host.
   */
  async function defaultFetch(
    url: string,
    init: { method: string; headers: Record<string, string>; body?: string },
  ): Promise<{ ok: boolean; status: number; body?: string }> {
    const res = await fetch(url, { ...init, redirect: 'manual' });
    // A receiver that sends no body is normal, and a body we fail to read is not a delivery failure.
    let body: string | undefined;
    try {
      body = await readBoundedText(res);
    } catch {
      body = undefined;
    }
    return { ok: res.ok, status: res.status, ...(body !== undefined ? { body } : {}) };
  }
}

interface TargetWorkerShape {
  enqueue(job: WebhookJob): void;
  whenIdle(): Promise<void>;
}

/** Exponential backoff for the nth retry (1-based), capped. */
export function backoffFor(attempt: number, base: number, max: number): number {
  return Math.min(max, base * 2 ** (attempt - 1));
}

/**
 * How many bytes of a response body are read before the rest is discarded.
 *
 * Generous next to the ~200 characters the delivery log keeps, and small enough that a receiver
 * streaming forever costs the bridge nothing (#494). Bytes, not characters, because the cap has to
 * hold before the text is decoded — the point is to stop reading, not to shorten a string we
 * already buffered.
 */
export const MAX_RESPONSE_BODY_BYTES = 4_096;

/** The delivery-log detail for a refused redirect. Ours, not the receiver's, and URL-free. */
export const REDIRECT_DETAIL =
  'The receiver answered with a redirect. Redirects are not followed, so nothing was delivered — ' +
  'point the subscription at the final URL instead.';

/** Whether a status is a redirect the delivery must refuse rather than follow. */
export function isRedirect(status: number): boolean {
  return status >= 300 && status < 400;
}

/**
 * Read at most {@link MAX_RESPONSE_BODY_BYTES} of a response, then drop the rest.
 *
 * `res.text()` reads to the end of the stream, which a hostile or malfunctioning receiver controls.
 * This reads chunk by chunk, stops at the cap and cancels the body, so the memory a single delivery
 * can cost is bounded no matter what the far end sends.
 *
 * A decode of a truncated tail can split a multi-byte character; `TextDecoder` renders that as a
 * replacement character, which is acceptable in a 200-character diagnostic and is why the read is
 * not retried or repaired.
 *
 * Exported so the cap can be tested against a stream that never ends, which is the case that
 * matters and which no real receiver would let a test reproduce reliably.
 */
export async function readBoundedText(res: Response): Promise<string | undefined> {
  const stream = res.body;
  if (stream === null || stream === undefined) return undefined;
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (total < MAX_RESPONSE_BODY_BYTES) {
      const { done, value } = await reader.read();
      // `done` and `value` lose their correlation when destructured, so an absent chunk is treated
      // as the end of the stream rather than skipped — skipping it could not terminate.
      if (done || value === undefined) break;
      chunks.push(value);
      total += value.byteLength;
    }
  } finally {
    // Releases the connection whether we stopped at the cap or at the end of the stream. A cancel
    // that rejects (an already-errored stream) must not become the delivery's error.
    await reader.cancel().catch(() => undefined);
  }
  if (chunks.length === 0) return '';
  const joined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(joined.subarray(0, MAX_RESPONSE_BODY_BYTES));
}

/**
 * Reduce a URL to origin + path for logs and the delivery log.
 *
 * The dropped query string is not merely tidiness: a `GET` delivery puts the whole payload there,
 * so keeping it would copy event data into every log line.
 *
 * Exported so the other places that write a delivery-log row — the `W7` test-fire endpoint and the
 * blocked-subscription reporter, both of which log a subscription dropped for an unresolvable
 * `secret_ref` before any delivery is attempted — redact it by the same rule rather than a second,
 * drifting one.
 */
export function redactUrl(url: string): string {
  try {
    const u = new URL(url);
    return `${u.origin}${u.pathname}`;
  } catch {
    return '<url>';
  }
}
