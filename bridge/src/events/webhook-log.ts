/**
 * The bridge-side **delivery log** (webhooks plan `W5`; see `docs/todo/done/webhooks_2026-07-18.md` §3.1).
 *
 * ## Why the log lives here and not in the database
 *
 * The obvious place to record "this webhook fired and got a 204" is the app's database — and it is
 * the one place it cannot go. The bridge is strictly read-only over a snapshot that is **swapped
 * wholesale on every hydration** (`generation.ts` / `pipeline.ts`), so a row it wrote would be
 * discarded by the next hydrate. Not "sometimes lost" — always, by construction.
 *
 * So the log is bridge-side and in-memory, and the app reads it over
 * `GET /api/v1/webhooks/deliveries` (on the existing bearer auth — no new auth surface), polling
 * only while the Webhooks screen is open. Without this the delivery log and "send test event" — the
 * feature's two debugging affordances — would show nothing at all, which is why §3.1 calls the
 * endpoint non-optional.
 *
 * In-memory means **the log does not survive a bridge restart**, and that is the right trade for a
 * debugging aid: persisting it would mean the bridge owning storage of its own, with its own
 * retention, corruption and growth questions, to preserve records whose value is almost entirely in
 * the minutes after a delivery.
 *
 * ## What is never recorded
 *
 * No secret, no signature, no request headers, and no query string. A record carries the target id,
 * the **redacted** URL (origin + path, the existing `redactUrl` precedent), the method, the event
 * id/type, the outcome, the attempt count and the response status. Response *bodies* are truncated
 * hard: a receiver's error body is useful for debugging ("invalid channel id"), but an unbounded one
 * would be both a memory risk and a way to pull arbitrary third-party content into the app's UI.
 *
 * Pure and I/O-free apart from the injected clock, so it tests directly.
 *
 * Imported by the bridge, so it must survive Node's **strip-only** loader: no `enum`, no
 * `namespace`, no TS parameter properties.
 */

/** How a delivery ended. */
export type WebhookDeliveryOutcome =
  /** The receiver answered 2xx. */
  | 'delivered'
  /** Every attempt was made and none succeeded (HTTP error or transport failure). */
  | 'failed'
  /** Refused before any request was issued — the SSRF guard, or a target whose secret is missing. */
  | 'blocked'
  /** Not attempted because the target's failure circuit was open. */
  | 'skipped';

/** One recorded delivery attempt-sequence. Contains no secret, signature, header or query string. */
export interface WebhookDeliveryRecord {
  /** Monotonic per-log sequence number, so a poller can ask for "everything after n". */
  readonly seq: number;
  /** Epoch-ms when the delivery finished. */
  readonly at: number;
  readonly targetId: string;
  readonly targetName: string;
  readonly source: 'database' | 'config';
  /** Origin + path only — never the query string, which a `GET` delivery fills with payload data. */
  readonly url: string;
  readonly method: string;
  /** Empty for a row that records a refusal decided before any event was considered. */
  readonly eventId: string;
  /** Empty for a row that records a refusal decided before any event was considered. */
  readonly eventType: string;
  readonly outcome: WebhookDeliveryOutcome;
  /** How many HTTP attempts were made (0 when blocked or skipped). */
  readonly attempts: number;
  /** The final response status, or `null` when no response was ever received. */
  readonly status: number | null;
  /** A short, truncated diagnostic — a transport error message or a refusal reason. Never a secret. */
  readonly detail: string | null;
}

/** Default number of records retained. Old records are evicted oldest-first. */
export const DEFAULT_DELIVERY_LOG_SIZE = 200;
/** Hard cap on how many records one read may return. */
export const MAX_DELIVERY_LOG_PAGE = 200;
/** Maximum length of a recorded `detail` string, so a receiver's error body cannot grow unbounded. */
export const MAX_DELIVERY_DETAIL_LENGTH = 200;

/** What a caller supplies to record a delivery; `seq` and `at` are assigned by the log. */
export type WebhookDeliveryInput = Omit<WebhookDeliveryRecord, 'seq' | 'at'>;

export interface WebhookDeliveryLog {
  /** Record one finished delivery. Returns the stored record (with its assigned `seq`). */
  record(input: WebhookDeliveryInput): WebhookDeliveryRecord;
  /**
   * The most recent records, **newest first**. `since` returns only records with a greater `seq`
   * (the polling case); `limit` is clamped to {@link MAX_DELIVERY_LOG_PAGE}.
   */
  list(options?: { readonly since?: number; readonly limit?: number }): readonly WebhookDeliveryRecord[];
  /** The highest `seq` assigned so far — what a poller passes back as `since`. */
  latestSeq(): number;
}

export interface WebhookDeliveryLogOptions {
  /** How many records to retain (default {@link DEFAULT_DELIVERY_LOG_SIZE}). */
  readonly size?: number;
  /** Injectable clock (defaults to `Date.now`). */
  readonly now?: () => number;
}

/** Truncate a diagnostic string, marking it so a reader knows it was cut rather than empty. */
function truncateDetail(detail: string | null): string | null {
  if (detail === null) return null;
  const trimmed = detail.trim();
  if (trimmed.length === 0) return null;
  return trimmed.length <= MAX_DELIVERY_DETAIL_LENGTH
    ? trimmed
    : `${trimmed.slice(0, MAX_DELIVERY_DETAIL_LENGTH)}…`;
}

/**
 * Create the bounded, in-memory delivery log.
 *
 * A plain array used as a ring: `record` pushes and shifts past the cap. At a couple of hundred
 * entries the shift is irrelevant, and the alternative (a real ring buffer with a head index) buys
 * nothing but the chance to get the wrap-around arithmetic wrong.
 */
export function createWebhookDeliveryLog(options: WebhookDeliveryLogOptions = {}): WebhookDeliveryLog {
  const size = Math.max(1, options.size ?? DEFAULT_DELIVERY_LOG_SIZE);
  const now = options.now ?? Date.now;
  const records: WebhookDeliveryRecord[] = [];
  let seq = 0;

  return {
    record(input: WebhookDeliveryInput): WebhookDeliveryRecord {
      const stored: WebhookDeliveryRecord = {
        ...input,
        detail: truncateDetail(input.detail),
        seq: ++seq,
        at: now(),
      };
      records.push(stored);
      while (records.length > size) records.shift();
      return stored;
    },

    list(listOptions = {}): readonly WebhookDeliveryRecord[] {
      const limit = Math.min(
        MAX_DELIVERY_LOG_PAGE,
        Math.max(1, Math.floor(listOptions.limit ?? MAX_DELIVERY_LOG_PAGE)),
      );
      const since = listOptions.since;
      const matching = since === undefined ? records : records.filter((r) => r.seq > since);
      // Newest first, then capped — a poller wants the latest, not the oldest of a long backlog.
      return matching.slice(-limit).reverse();
    },

    latestSeq(): number {
      return seq;
    },
  };
}
