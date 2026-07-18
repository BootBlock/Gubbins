/**
 * Webhook-subscription row + DTO types (issue #87 — "call this URL when this happens").
 *
 * A subscription is configured in the app and synced like any other user record, but is
 * delivered **solely by the bridge** (plan §1) — the browser cannot reliably reach the
 * endpoints users own. It references no item, category or location: narrowing is expressed
 * by the declarative {@link WebhookFilter}, so, like `wishlist` / `tare_presets`, the table
 * is an independent synced LWW leaf with a random-UUID primary key.
 *
 * Three columns hold JSON as opaque TEXT in SQLite (`event_types`, `filter`, `headers`).
 * They are parsed and re-serialised at the repository boundary, so a caller only ever sees
 * the typed shapes below — never a string it has to `JSON.parse` itself.
 */
import type { WebhookMethod } from '../constants';

export interface WebhookRow {
  readonly id: string;
  readonly name: string;
  readonly url: string;
  readonly method: string;
  readonly enabled: number;
  readonly secret: string | null;
  readonly secret_ref: string | null;
  readonly event_types: string;
  readonly filter: string | null;
  readonly template: string | null;
  readonly headers: string | null;
  readonly created_at: number;
  readonly updated_at: number;
}

/**
 * A declarative, JSON-serialisable narrowing beyond the event type — a location subtree, a
 * category, a tag, an item, a quantity threshold.
 *
 * Deliberately opaque at this layer: the filter *vocabulary* and its pure evaluator are the
 * next phase's concern, and storage must not fossilise a shape the matcher has not yet
 * agreed. It is always a data structure evaluated by a pure matcher — never a user-supplied
 * expression string that gets interpreted or `eval`'d.
 */
export type WebhookFilter = Readonly<Record<string, unknown>>;

/** Extra static request headers, as a flat name → value map. */
export type WebhookHeaders = Readonly<Record<string, string>>;

/** A configured webhook subscription. */
export interface WebhookSubscription {
  readonly id: string;
  readonly name: string;
  /** Absolute `http(s)` endpoint the bridge delivers to. */
  readonly url: string;
  readonly method: WebhookMethod;
  readonly enabled: boolean;
  /**
   * HMAC signing secret held in the row. `null` when the subscription signs with a
   * bridge-side secret ({@link secretRef}) or is unsigned. Mutually exclusive with
   * {@link secretRef} — a DB CHECK refuses a row carrying both.
   *
   * This value travels in the sync artefact and any backup; {@link secretRef} does not, and
   * is the option the UI steers to (plan §6.1).
   */
  readonly secret: string | null;
  /** Name of a secret held in the bridge's own config; the value never enters the database. */
  readonly secretRef: string | null;
  /** Dotted event types this subscription wants, or `['*']` for every event. */
  readonly eventTypes: readonly string[];
  /** Extra narrowing, or `null` for "every event of the subscribed types". */
  readonly filter: WebhookFilter | null;
  /** Payload template, or `null` for the default bridge event envelope. */
  readonly template: string | null;
  readonly headers: WebhookHeaders | null;
  readonly createdAt: number;
  readonly updatedAt: number;
}

/** Parameters for creating a webhook subscription. */
export interface CreateWebhookInput {
  readonly name: string;
  readonly url: string;
  /** One of {@link WebhookMethod}; anything unknown or absent softens to `POST`. */
  readonly method?: string | null;
  /** Defaults to enabled. */
  readonly enabled?: boolean;
  readonly secret?: string | null;
  readonly secretRef?: string | null;
  /** At least one dotted event type (or `['*']`). */
  readonly eventTypes: readonly string[];
  readonly filter?: WebhookFilter | null;
  readonly template?: string | null;
  readonly headers?: WebhookHeaders | null;
}

/**
 * Parameters for updating a webhook subscription. Each field is optional; only the provided
 * fields change (a provided `null` clears the optional field). `name`/`url` cannot be cleared,
 * `eventTypes` cannot be emptied, and `secret`/`secretRef` cannot both end up set.
 */
export interface UpdateWebhookInput {
  readonly name?: string;
  readonly url?: string;
  readonly method?: string | null;
  readonly enabled?: boolean;
  readonly secret?: string | null;
  readonly secretRef?: string | null;
  readonly eventTypes?: readonly string[];
  readonly filter?: WebhookFilter | null;
  readonly template?: string | null;
  readonly headers?: WebhookHeaders | null;
}
