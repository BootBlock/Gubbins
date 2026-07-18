/**
 * Webhook **delivery targets** — the merged target model and where targets come from
 * (webhooks plan `W5`; see `docs/todo/webhooks_2026-07-18.md` §3.1, §6.1).
 *
 * Two sources feed one list:
 *
 *   1. **The app's `webhooks` table**, read out of the database the bridge already hydrates. This
 *      is the whole point of the feature — the user configures a subscription in the PWA, it rides
 *      the existing sync/push, and the bridge delivers it. **No new config endpoint, no new token,
 *      no new auth surface** (§3.1): the subscriptions arrive through a channel that already
 *      exists and is already trusted.
 *   2. **The operator's `webhooks.json` / `GUBBINS_BRIDGE_WEBHOOKS_TARGETS`**, which predates this
 *      phase (EI-1) and **stays supported**. An operator running the bridge as a service may
 *      reasonably prefer config they can put in version control of their own, and breaking that to
 *      force everyone through the UI would be a gratuitous regression.
 *
 * The two are merged rather than one winning: they are not alternatives, they are different people
 * expressing different intents, and a bridge with both should honour both.
 *
 * ## `secret_ref` resolution, and why an unresolvable ref must fail loudly
 *
 * A subscription signs with **either** an in-row `secret` **or** a `secret_ref` naming a secret in
 * the bridge's git-ignored config — never both (a DB CHECK enforces it) — or with neither, since an
 * unsigned webhook to a trusted LAN endpoint is legitimate. `secret_ref` is the recommended path
 * (§6.1): the value never enters the database, so it never reaches the sync artefact sitting on a
 * NAS or in a cloud drive, nor any backup.
 *
 * A `secret_ref` the bridge cannot resolve is therefore a **hard failure for that subscription**:
 * it is dropped, and the operator is told which name is missing. The tempting alternative —
 * deliver it unsigned — is exactly wrong. The user asked for a signed webhook; their receiver is
 * verifying signatures; silently downgrading to unsigned would either break delivery confusingly or,
 * worse, succeed against a receiver that treats a missing signature as acceptable. Failing loudly
 * on the bridge, where the operator can fix it, is the only safe direction.
 *
 * Nothing here logs a secret, a ref's *value*, or a full URL — refusals name the subscription and
 * the missing ref's *name* only.
 *
 * Imported by the bridge, so it must survive Node's **strip-only** loader: no `enum`, no
 * `namespace`, no TS parameter properties.
 */
import { WebhookRepository } from '@/db/repositories/WebhookRepository.ts';
import type { IDatabaseDriver } from '@/db/rpc/driver';
import type { WebhookMethod } from '@/db/repositories/constants.ts';
import type { WebhookFilter } from '@/features/webhooks/filter.ts';
import { WEBHOOK_ALL_EVENTS } from '@/features/webhooks/subscription.ts';
import type { WebhookTarget } from './webhook.ts';

/**
 * One resolved destination the deliverer can act on, whatever it came from.
 *
 * Structurally a superset of `WebhookMatchTarget` (`enabled` / `eventTypes` / `filter`), so it
 * feeds `subscriptionMatches` with no adapter — which is the property that keeps the bridge and the
 * app's `W7` preview answering the same question.
 */
export interface WebhookDeliveryTarget {
  /** Stable id, used to correlate delivery-log rows. The row id, or `config:<n>` for file targets. */
  readonly id: string;
  /** Human label for logs and the delivery log. A file target has no name, so it gets its index. */
  readonly name: string;
  /** Where the target came from — surfaced in the delivery log so the UI can say so. */
  readonly source: 'database' | 'config';
  readonly url: string;
  readonly method: WebhookMethod;
  readonly enabled: boolean;
  /** The resolved signing secret, or `null` for an unsigned target. Never logged. */
  readonly secret: string | null;
  readonly eventTypes: readonly string[];
  readonly filter: WebhookFilter | null;
  readonly template: string | null;
  readonly headers: Readonly<Record<string, string>> | null;
}

/**
 * Header names a subscription may **not** set (§6.4).
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
const GUBBINS_HEADER_PREFIX = 'x-gubbins-';

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

/** A named secret held in the bridge's own git-ignored config, keyed by the name a row references. */
export type WebhookSecrets = Readonly<Record<string, string>>;

/** The outcome of sourcing targets: what to deliver to, plus the problems worth telling the operator. */
export interface WebhookTargetResolution {
  readonly targets: readonly WebhookDeliveryTarget[];
  /** Secret-free, one-line diagnostics (a missing `secret_ref`, a dropped header). */
  readonly warnings: readonly string[];
}

/**
 * Adapt an operator's file/env target to the merged model.
 *
 * The legacy shape carries only `{ url, secret, events? }`, so everything the richer model adds
 * takes its most permissive-yet-unsurprising default: `POST` (what EI-1 always sent), enabled, no
 * filter, no template (the default envelope — so an existing receiver sees byte-identical bodies),
 * and no extra headers. An absent/empty `events` list becomes `['*']`, matching
 * `targetWantsType`'s original "no filter means everything" rule.
 */
export function configTargetToDeliveryTarget(target: WebhookTarget, index: number): WebhookDeliveryTarget {
  const events = target.events;
  return {
    id: `config:${index}`,
    name: `Configured target ${index + 1}`,
    source: 'config',
    url: target.url,
    method: 'POST',
    enabled: true,
    secret: target.secret,
    eventTypes: events === undefined || events.length === 0 ? [WEBHOOK_ALL_EVENTS] : events,
    filter: null,
    template: null,
    headers: null,
  };
}

/**
 * How many subscription rows to read per page, and the ceiling on how many to load in total.
 *
 * The page size is the repository's own maximum. The total cap is a safety bound on a pathological
 * synced table: every target multiplies the outbound request volume of every event, so a runaway
 * row count is a self-inflicted denial of service on the operator's own network. Hitting it warns
 * rather than failing — the first `MAX_DB_TARGETS` still work.
 */
const DB_TARGET_PAGE_SIZE = 100;
const MAX_DB_TARGETS = 500;

/**
 * Read the app-configured subscriptions out of the hydrated database, resolving each one's signing
 * secret.
 *
 * Disabled subscriptions are loaded rather than filtered out here: `subscriptionMatches` checks
 * `enabled` itself, and keeping them in the list means one place decides what "disabled" means (the
 * `W3` matcher) instead of two that can drift.
 */
export async function loadDatabaseWebhookTargets(
  driver: IDatabaseDriver,
  secrets: WebhookSecrets,
): Promise<WebhookTargetResolution> {
  const repository = new WebhookRepository(driver);
  const targets: WebhookDeliveryTarget[] = [];
  const warnings: string[] = [];

  let offset = 0;
  for (;;) {
    const page = await repository.list({ limit: DB_TARGET_PAGE_SIZE, offset });
    for (const subscription of page.rows) {
      if (targets.length >= MAX_DB_TARGETS) break;

      // Exactly one of the two columns is set (a DB CHECK enforces it), so this is a resolution,
      // not a precedence rule: an in-row secret is used as-is, a ref is looked up, neither is
      // legitimately unsigned.
      let secret: string | null = subscription.secret;
      if (subscription.secretRef !== null) {
        const resolved = secrets[subscription.secretRef];
        if (resolved === undefined || resolved.length === 0) {
          // Dropped, never downgraded to unsigned — see the module note.
          warnings.push(
            `Webhook "${subscription.name}" references a bridge-side secret named ` +
              `"${subscription.secretRef}" that is not configured; it will not be delivered until ` +
              'you add it to the webhooks secrets config.',
          );
          continue;
        }
        secret = resolved;
      }

      const { headers, dropped } = sanitiseWebhookHeaders(subscription.headers);
      if (dropped.length > 0) {
        warnings.push(
          `Webhook "${subscription.name}" sets header(s) the bridge does not allow ` +
            `(${dropped.join(', ')}); they were ignored.`,
        );
      }

      targets.push({
        id: subscription.id,
        name: subscription.name,
        source: 'database',
        url: subscription.url,
        method: subscription.method,
        enabled: subscription.enabled,
        secret,
        eventTypes: subscription.eventTypes,
        filter: subscription.filter,
        template: subscription.template,
        headers,
      });
    }

    if (targets.length >= MAX_DB_TARGETS) {
      warnings.push(
        `More than ${MAX_DB_TARGETS} webhook subscriptions are configured; only the first ` +
          `${MAX_DB_TARGETS} are active.`,
      );
      break;
    }
    if (page.rows.length < DB_TARGET_PAGE_SIZE) break;
    offset += DB_TARGET_PAGE_SIZE;
  }

  return { targets, warnings };
}

/**
 * Validate an untrusted value (parsed JSON from the targets file / env) into a
 * {@link WebhookSecrets} map: a flat object of name → non-empty string.
 *
 * Throws a **secret-free** error on a bad shape — the message names the offending *key*, never a
 * value. An absent value is an empty map, not an error: `secret_ref` is optional, and a bridge with
 * no named secrets is a perfectly normal configuration.
 */
export function parseWebhookSecrets(value: unknown): WebhookSecrets {
  if (value === undefined || value === null) return {};
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Webhook secrets must be a JSON object of { "name": "secret" } entries.');
  }
  const secrets: Record<string, string> = {};
  for (const [name, secret] of Object.entries(value as Record<string, unknown>)) {
    const key = name.trim();
    if (key.length === 0) throw new Error('A webhook secret name may not be blank.');
    if (typeof secret !== 'string' || secret.length === 0) {
      throw new Error(`Webhook secret "${key}" must be a non-empty string.`);
    }
    secrets[key] = secret;
  }
  return secrets;
}
