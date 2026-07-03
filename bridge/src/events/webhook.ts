/**
 * Outbound webhook delivery (EI-1) — opt-in (`GUBBINS_BRIDGE_WEBHOOKS=on`), off by default.
 *
 * For each configured target, every matching event is POSTed as a JSON body carrying an
 * `X-Gubbins-Signature: sha256=<hex>` HMAC-SHA256 of the **raw body** (the GitHub/Stripe
 * pattern) plus a unique `X-Gubbins-Delivery` id, so a receiver can verify authenticity and
 * dedupe. Delivery is at-least-once with bounded exponential backoff, and each target has its
 * own FIFO queue + failure circuit, so one dead URL can neither stall the others nor retry
 * forever. Zero dependencies — `node:crypto` + the global `fetch`.
 *
 * Secrets live only in the target config the operator supplies (a git-ignored
 * `bridge/webhooks.json` / an env var); nothing here is ever logged.
 */
import { createHmac, randomUUID } from 'node:crypto';
import type { BridgeEvent } from './model.ts';
import type { EventSink } from './pipeline.ts';

/** One webhook destination: where to POST, the signing secret, and an optional type filter. */
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

/** A minimal fetch shape so tests can inject a fake without pulling in DOM lib types. */
export type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string },
) => Promise<{ ok: boolean; status: number }>;

export interface WebhookDelivererOptions {
  readonly targets: readonly WebhookTarget[];
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

/** Create the deliverer. Each target gets its own ordered queue + circuit; targets never block each other. */
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

  const workers = options.targets.map((target) => createTargetWorker(target));

  /** One target's ordered queue + retry loop + failure circuit. */
  function createTargetWorker(target: WebhookTarget): TargetWorkerShape {
    const queue: BridgeEvent[] = [];
    let running = false;
    let consecutiveFailures = 0;
    let circuitOpenUntil = 0;
    let idleWaiters: Array<() => void> = [];

    async function drain(): Promise<void> {
      running = true;
      try {
        while (queue.length > 0) {
          const event = queue.shift()!;
          if (now() < circuitOpenUntil) {
            log(`Webhook target skipped (circuit open): ${redactUrl(target.url)}`);
            continue;
          }
          const ok = await deliverWithRetry(target, event);
          if (ok) {
            consecutiveFailures = 0;
          } else if (++consecutiveFailures >= circuitThreshold) {
            circuitOpenUntil = now() + cooldown;
            log(
              `Webhook target circuit opened after ${consecutiveFailures} failures: ${redactUrl(target.url)}`,
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

    async function deliverWithRetry(t: WebhookTarget, event: BridgeEvent): Promise<boolean> {
      const body = JSON.stringify(event);
      const headers = {
        'content-type': 'application/json; charset=utf-8',
        [SIGNATURE_HEADER]: signBody(t.secret, body),
        [DELIVERY_HEADER]: newDeliveryId(),
        [EVENT_TYPE_HEADER]: event.type,
      };
      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
          const res = await fetchImpl(t.url, { method: 'POST', headers: { ...headers }, body });
          if (res.ok) return true;
          log(`Webhook delivery got HTTP ${res.status} from ${redactUrl(t.url)} (attempt ${attempt}).`);
        } catch (err) {
          log(`Webhook delivery failed to ${redactUrl(t.url)} (attempt ${attempt}): ${errMessage(err)}`);
        }
        if (attempt < maxAttempts) await sleep(backoffFor(attempt, baseBackoff, maxBackoff));
      }
      return false;
    }

    return {
      enqueue(event: BridgeEvent): void {
        if (queue.length >= maxQueue) {
          log(`Webhook queue full for ${redactUrl(target.url)}; dropping an event.`);
          return;
        }
        queue.push(event);
        if (!running) void drain();
      },
      whenIdle(): Promise<void> {
        if (!running && queue.length === 0) return Promise.resolve();
        return new Promise<void>((resolve) => idleWaiters.push(resolve));
      },
      wants: (type: string) => targetWantsType(target, type),
    };
  }

  return {
    deliver(events: readonly BridgeEvent[]): void {
      for (const worker of workers) {
        for (const event of events) {
          if (worker.wants(event.type)) worker.enqueue(event);
        }
      }
    },
    whenIdle(): Promise<void> {
      return Promise.all(workers.map((w) => w.whenIdle())).then(() => undefined);
    },
  };

  /** The default transport: the global `fetch`, narrowed to {@link FetchLike}. */
  async function defaultFetch(
    url: string,
    init: { method: string; headers: Record<string, string>; body: string },
  ): Promise<{ ok: boolean; status: number }> {
    const res = await fetch(url, init);
    return { ok: res.ok, status: res.status };
  }
}

interface TargetWorkerShape {
  enqueue(event: BridgeEvent): void;
  whenIdle(): Promise<void>;
  wants(type: string): boolean;
}

/** Exponential backoff for the nth retry (1-based), capped. */
export function backoffFor(attempt: number, base: number, max: number): number {
  return Math.min(max, base * 2 ** (attempt - 1));
}

/** Reduce a URL to origin + path for logs (drop any query — it must never carry a secret anyway). */
function redactUrl(url: string): string {
  try {
    const u = new URL(url);
    return `${u.origin}${u.pathname}`;
  } catch {
    return '<url>';
  }
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
