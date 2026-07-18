/**
 * Which extra request headers a webhook subscription may set (webhooks plan §6.4).
 *
 * ## Why this lives in `src/` rather than beside the deliverer
 *
 * The rule is enforced at delivery, on the bridge — that is the security boundary and it does not
 * move. But the *app* is where the user types a header name, and a rule only the deliverer knows is
 * a rule the user discovers by their header silently not arriving at the receiver.
 *
 * So the list lives here and the bridge imports it back over the existing one-way `@/` alias, the
 * same shape `W0` used for the event-type map. One definition, checked in the editor **and**
 * enforced at delivery, with no possibility of the two drifting apart — a UI copy of a security
 * list that quietly disagrees with the real one is worse than no check at all.
 *
 * This module is imported by the bridge, so it must survive Node's **strip-only** loader: no
 * `enum`, no `namespace`, no TS parameter properties.
 */

/**
 * Header names a subscription may **not** set.
 *
 * Two kinds of name are refused. `authorization` / `cookie` / `proxy-authorization` are credentials:
 * a subscription that could set them would be a way to aim the *operator's* bridge at a third-party
 * host carrying a header the user chose, which is a request-forgery primitive dressed as
 * configuration. The rest (`host`, `content-length`, `content-type`, the `x-gubbins-*` family) are
 * ones the deliverer computes: letting a subscription overwrite `X-Gubbins-Signature` would let it
 * forge its own signature, and overriding `content-length` desynchronises the request.
 */
export const WEBHOOK_FORBIDDEN_HEADERS: readonly string[] = [
  'authorization',
  'proxy-authorization',
  'cookie',
  'set-cookie',
  'host',
  'content-length',
  'content-type',
  'transfer-encoding',
  'connection',
];

/** The reserved prefix the deliverer's own headers use; a subscription may not set any of them. */
export const GUBBINS_HEADER_PREFIX = 'x-gubbins-';

/** Is this a header name a subscription is allowed to set? */
export function isAllowedWebhookHeader(name: string): boolean {
  const lower = name.trim().toLowerCase();
  if (lower.length === 0) return false;
  if (lower.startsWith(GUBBINS_HEADER_PREFIX)) return false;
  return !WEBHOOK_FORBIDDEN_HEADERS.includes(lower);
}

/**
 * Drop any header a subscription may not set, returning the survivors (or `null` when none).
 *
 * Filtered rather than rejected: a subscription that also sets three legitimate headers should keep
 * them. The caller reports what was dropped so the operator learns why their `Authorization` header
 * is not arriving, instead of debugging it at the receiver.
 */
export function sanitiseWebhookHeaders(headers: Readonly<Record<string, string>> | null): {
  readonly headers: Readonly<Record<string, string>> | null;
  readonly dropped: readonly string[];
} {
  if (headers === null) return { headers: null, dropped: [] };
  const kept: Record<string, string> = {};
  const dropped: string[] = [];
  for (const [name, value] of Object.entries(headers)) {
    if (isAllowedWebhookHeader(name)) kept[name.trim()] = value;
    else dropped.push(name.trim());
  }
  return { headers: Object.keys(kept).length > 0 ? kept : null, dropped };
}

/**
 * Why a header name typed into the editor is not usable, or `null` when it is fine.
 *
 * Exists so the editor can say *which* rule a name breaks rather than just refusing it — "that name
 * is reserved for the signature" and "that name is a credential" are different mistakes.
 */
export type WebhookHeaderIssue = 'empty' | 'reserved' | 'forbidden';

export function webhookHeaderIssue(name: string): WebhookHeaderIssue | null {
  const lower = name.trim().toLowerCase();
  if (lower.length === 0) return 'empty';
  if (lower.startsWith(GUBBINS_HEADER_PREFIX)) return 'reserved';
  if (WEBHOOK_FORBIDDEN_HEADERS.includes(lower)) return 'forbidden';
  return null;
}
