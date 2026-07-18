/**
 * Pure webhook-subscription seam (issue #87 — "call this URL when this happens").
 *
 * A subscription is the *configuration* half of the feature: which URL, which HTTP method,
 * which events, what extra headers, and how it is signed. The app owns configuration; the
 * bridge owns delivery. This module owns the vocabulary and all of the non-trivial
 * validation/normalisation of a subscription — and nothing else: no React, no repository, no
 * SQL, no network. The same "logic out of glue" seam as `wishlist.ts` / `tare-presets.ts`,
 * which keeps it exhaustively unit-testable and lets the bridge reuse it verbatim.
 *
 * ## The signing secret, and why there are two columns (plan §6.1)
 *
 * `secretRef` — the *name* of a secret held in the bridge's own git-ignored config — is the
 * **recommended** option, and this seam is written to keep it the cheap one: the value never
 * enters the database, so it never reaches the sync artefact (which by design sits on a NAS or
 * in a cloud drive) or a backup. `secret` holds the value in the row instead: zero setup, but
 * it travels with synced data, which the UI and the wiki must say plainly rather than bury.
 *
 * Setting **both** is refused here (and by a DB CHECK) because it leaves ambiguous which
 * secret actually signs a delivery. Setting **neither** is legal — an unsigned webhook to a
 * trusted endpoint on your own LAN is a reasonable thing to want.
 *
 * Note the deliberate asymmetry with the wishlist seam: an unrecognised HTTP *method* softens
 * to `POST` (the set is fixed by HTTP and guarded by a DB CHECK, so a bad value could never be
 * written anyway), whereas a bad *URL* is rejected outright — silently "fixing" the address a
 * user's events are sent to would be worse than telling them it is wrong.
 */
import { WEBHOOK_METHODS, type WebhookMethod } from '@/db/repositories/constants';
import type { WebhookHeaders } from '@/db/repositories/types';
import { parseWebhookFilter, type WebhookFilter } from './filter';

/** The method a subscription takes when none is chosen (or an unknown one is supplied). */
export const DEFAULT_WEBHOOK_METHOD: WebhookMethod = 'POST';

/** The event-type wildcard: subscribe to everything the engine emits. */
export const WEBHOOK_ALL_EVENTS = '*';

/** Type guard: is `value` one of the supported HTTP methods? */
export function isWebhookMethod(value: unknown): value is WebhookMethod {
  return typeof value === 'string' && (WEBHOOK_METHODS as readonly string[]).includes(value);
}

/**
 * Coerce arbitrary text to a known {@link WebhookMethod}, falling back to
 * {@link DEFAULT_WEBHOOK_METHOD}. Trims + upper-cases so casing/whitespace from an import or a
 * stale peer row is forgiving; anything unrecognised (or absent) becomes `POST` rather than
 * throwing.
 */
export function normaliseWebhookMethod(raw: string | null | undefined): WebhookMethod {
  if (raw == null) return DEFAULT_WEBHOOK_METHOD;
  const key = raw.trim().toUpperCase();
  return isWebhookMethod(key) ? key : DEFAULT_WEBHOOK_METHOD;
}

/** Trim a subscription name to its canonical form, or `null` when it is blank. */
export function normaliseWebhookName(raw: string | null | undefined): string | null {
  const trimmed = raw?.trim();
  return trimmed ? trimmed : null;
}

/** Trim an optional free-text field (secret, secret ref, template) to its form, or `null`. */
export function normaliseWebhookText(raw: string | null | undefined): string | null {
  const trimmed = raw?.trim();
  return trimmed ? trimmed : null;
}

/**
 * Validate a user-supplied endpoint as an absolute `http(s)` URL, or `undefined` when it is
 * not one.
 *
 * Stricter than the wishlist's link sanitiser in two ways, both deliberate. A missing scheme
 * is **not** defaulted to `https://`: the wishlist guesses because the value is a convenience
 * link a human clicks, whereas this is the address a stream of inventory events is posted to,
 * and quietly guessing `https` for a LAN box the user meant to reach over `http` produces a
 * subscription that silently never delivers. A blank value is also rejected rather than
 * becoming `null` — a subscription with no endpoint is not a subscription.
 *
 * Non-`http(s)` schemes (`file:`, `javascript:`, …) are refused: the bridge would either fail
 * to issue them or reach something that is not a webhook receiver at all.
 */
export function sanitiseWebhookUrl(raw: string | null | undefined): string | undefined {
  const trimmed = raw?.trim();
  if (!trimmed) return undefined;
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return undefined; // unparseable, or relative (no scheme)
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return undefined;
  return parsed.href;
}

/**
 * Normalise a requested event-type list: trim each entry, drop blanks, and de-duplicate while
 * preserving the caller's order. Returns `undefined` when nothing usable survives — a
 * subscription matching no event type would be silently inert, so that is an error rather
 * than an empty list.
 *
 * A list containing {@link WEBHOOK_ALL_EVENTS} collapses to just `['*']`: the wildcard already
 * covers every named type beside it, and keeping both would make the stored list read as if
 * the named ones were doing something.
 */
export function normaliseWebhookEventTypes(raw: readonly string[] | null | undefined): string[] | undefined {
  if (raw == null) return undefined;
  const seen = new Set<string>();
  for (const entry of raw) {
    const trimmed = typeof entry === 'string' ? entry.trim() : '';
    if (trimmed) seen.add(trimmed);
  }
  if (seen.size === 0) return undefined;
  if (seen.has(WEBHOOK_ALL_EVENTS)) return [WEBHOOK_ALL_EVENTS];
  return [...seen];
}

/**
 * Normalise an optional map of extra static request headers to a plain name → value object,
 * or `null` when there is none. Returns `undefined` when a value was supplied but is not a
 * usable header map (a blank name, or a value that is not a string).
 *
 * Header *names* are trimmed but otherwise passed through: which names a subscription may set
 * is a delivery-side concern (a deny-list stops a template forging `authorization` onto an
 * unrelated host), and duplicating that policy here would let the two drift.
 */
export function normaliseWebhookHeaders(
  raw: WebhookHeaders | null | undefined,
): WebhookHeaders | null | undefined {
  if (raw == null) return null;
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(raw)) {
    const trimmedName = name.trim();
    if (!trimmedName) return undefined; // supplied but invalid
    if (typeof value !== 'string') return undefined;
    headers[trimmedName] = value;
  }
  return Object.keys(headers).length > 0 ? headers : null;
}

/** A validated, ready-to-persist subscription (the shape a create writes). */
export interface NormalisedWebhookSubscription {
  readonly name: string;
  readonly url: string;
  readonly method: WebhookMethod;
  readonly enabled: boolean;
  readonly secret: string | null;
  readonly secretRef: string | null;
  readonly eventTypes: readonly string[];
  readonly filter: WebhookFilter | null;
  readonly template: string | null;
  readonly headers: WebhookHeaders | null;
}

/** Raw create input, before validation/normalisation. */
export interface WebhookSubscriptionDraft {
  readonly name: string;
  readonly url: string;
  readonly method?: string | null;
  readonly enabled?: boolean;
  readonly secret?: string | null;
  readonly secretRef?: string | null;
  readonly eventTypes: readonly string[];
  readonly filter?: WebhookFilter | null;
  readonly template?: string | null;
  readonly headers?: WebhookHeaders | null;
}

/** Why a proposed subscription was rejected (see {@link planWebhookSubscription}). */
export type WebhookPlanError =
  'EMPTY_NAME' | 'INVALID_URL' | 'NO_EVENT_TYPES' | 'SECRET_CONFLICT' | 'INVALID_HEADERS';

export type WebhookPlan =
  | { readonly ok: true; readonly subscription: NormalisedWebhookSubscription }
  | { readonly ok: false; readonly reason: WebhookPlanError };

/**
 * Validate + normalise a proposed subscription — the single choke-point every create goes
 * through, so the invariants live in one tested place. A blank name, a non-`http(s)` endpoint,
 * an empty event-type list, both secret forms at once, or a malformed header map are each
 * rejected with a specific reason; an unknown method softens to `POST`. On success the
 * returned {@link NormalisedWebhookSubscription} is trimmed and safe to persist verbatim.
 */
export function planWebhookSubscription(draft: WebhookSubscriptionDraft): WebhookPlan {
  const name = normaliseWebhookName(draft.name);
  if (name === null) return { ok: false, reason: 'EMPTY_NAME' };

  const url = sanitiseWebhookUrl(draft.url);
  if (url === undefined) return { ok: false, reason: 'INVALID_URL' };

  const eventTypes = normaliseWebhookEventTypes(draft.eventTypes);
  if (eventTypes === undefined) return { ok: false, reason: 'NO_EVENT_TYPES' };

  const secret = normaliseWebhookText(draft.secret);
  const secretRef = normaliseWebhookText(draft.secretRef);
  if (secret !== null && secretRef !== null) return { ok: false, reason: 'SECRET_CONFLICT' };

  const headers = normaliseWebhookHeaders(draft.headers);
  if (headers === undefined) return { ok: false, reason: 'INVALID_HEADERS' };

  return {
    ok: true,
    subscription: {
      name,
      url,
      method: normaliseWebhookMethod(draft.method),
      enabled: draft.enabled ?? true,
      secret,
      secretRef,
      eventTypes,
      // Parsed rather than trusted: this is the one choke-point a create goes through, so the
      // filter that reaches storage is always the canonical shape the evaluator understands.
      // An unrecognised filter becomes the inert `none` node — never silently "no filter", which
      // would widen the subscription to every event of its types (see `filter.ts`).
      filter: parseWebhookFilter(draft.filter),
      template: normaliseWebhookText(draft.template),
      headers,
    },
  };
}
