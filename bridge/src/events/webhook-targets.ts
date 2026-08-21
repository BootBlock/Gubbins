/**
 * Webhook **delivery targets** — the merged target model and where targets come from
 * (webhooks plan `W5`; see `docs/todo/done/webhooks_2026-07-18.md` §3.1, §6.1).
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
import type { WebhookSubscription } from '@/db/repositories/types';
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
 * The header allow-rule (§6.4) is **shared with the app**, not defined here: the app's subscription
 * editor checks a header name as it is typed, and the deliverer enforces the same rule at send
 * time. One definition, imported back over the existing one-way `@/` alias — a UI copy that
 * drifted from the enforced list would be worse than no check at all.
 *
 * Re-exported so this module stays the single import site for everything target-shaped.
 */
import { sanitiseWebhookHeaders } from '@/features/webhooks/headers.ts';

export {
  WEBHOOK_FORBIDDEN_HEADERS,
  isAllowedWebhookHeader,
  sanitiseWebhookHeaders,
} from '@/features/webhooks/headers.ts';

/** A named secret held in the bridge's own git-ignored config, keyed by the name a row references. */
export type WebhookSecrets = Readonly<Record<string, string>>;

/** The outcome of sourcing targets: what to deliver to, plus the problems worth telling the operator. */
export interface WebhookTargetResolution {
  readonly targets: readonly WebhookDeliveryTarget[];
  /** Secret-free, one-line diagnostics (a missing `secret_ref`, a dropped header). */
  readonly warnings: readonly string[];
  /**
   * The **enabled** subscriptions that were dropped rather than delivered, structured enough to
   * write a delivery-log row for (issue #643). A warning on the bridge's stdout is the only trace
   * an operator running under Docker or on a NAS may never see. A disabled subscription is left
   * out: it still earns its warning, but it is switched off rather than silently broken, and the
   * app should not report a problem the user made on purpose.
   */
  readonly blocked: readonly WebhookBlockedSubscription[];
}

/**
 * One subscription the bridge refused to deliver **as configured**, carrying everything a
 * delivery-log row needs. Named by subscription, never by secret value: `reason` is the same
 * secret-free sentence the operator gets on the console.
 */
export interface WebhookBlockedSubscription {
  readonly id: string;
  readonly name: string;
  readonly url: string;
  readonly method: WebhookMethod;
  readonly reason: string;
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
 * The result of mapping one synced subscription row to a delivery target.
 *
 * `target` is `null` when the subscription cannot be delivered **as configured** — today that means
 * only an unresolvable `secret_ref`, which drops it rather than downgrading it to unsigned (see the
 * module note). The warnings are secret-free and name the subscription and the missing ref's *name*.
 */
export interface WebhookSubscriptionMapping {
  readonly target: WebhookDeliveryTarget | null;
  readonly warnings: readonly string[];
  /** Set exactly when `target` is `null` — why it was dropped, in a shape a log row can use. */
  readonly blocked: WebhookBlockedSubscription | null;
}

/**
 * Map one `webhooks` row to a {@link WebhookDeliveryTarget}, resolving its signing secret and
 * sanitising its headers.
 *
 * Shared by the two places a subscription becomes a target: {@link loadDatabaseWebhookTargets}
 * (the per-generation delivery list) and the `POST /api/v1/webhooks/test` endpoint (`W7`'s
 * test-fire), so the `secret_ref` and forbidden-header rules cannot drift between "what a real
 * event does" and "what the test button reports" — which would make the test actively misleading.
 */
export function subscriptionToDeliveryTarget(
  subscription: WebhookSubscription,
  secrets: WebhookSecrets,
): WebhookSubscriptionMapping {
  const warnings: string[] = [];

  // Exactly one of the two columns is set (a DB CHECK enforces it), so this is a resolution,
  // not a precedence rule: an in-row secret is used as-is, a ref is looked up, neither is
  // legitimately unsigned.
  let secret: string | null = subscription.secret;
  if (subscription.secretRef !== null) {
    const resolved = secrets[subscription.secretRef];
    if (resolved === undefined || resolved.length === 0) {
      // Dropped, never downgraded to unsigned — see the module note.
      const reason =
        `Webhook "${subscription.name}" references a bridge-side secret named ` +
        `"${subscription.secretRef}" that is not configured; it will not be delivered until ` +
        'you add it to the webhooks secrets config.';
      warnings.push(reason);
      return {
        target: null,
        warnings,
        blocked: {
          id: subscription.id,
          name: subscription.name,
          url: subscription.url,
          method: subscription.method,
          reason,
        },
      };
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

  return {
    target: {
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
    },
    warnings,
    blocked: null,
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
  const blocked: WebhookBlockedSubscription[] = [];

  let offset = 0;
  for (;;) {
    const page = await repository.list({ limit: DB_TARGET_PAGE_SIZE, offset });
    for (const subscription of page.rows) {
      if (targets.length >= MAX_DB_TARGETS) break;
      const mapped = subscriptionToDeliveryTarget(subscription, secrets);
      warnings.push(...mapped.warnings);
      // A subscription the user has switched off is not a webhook that has silently stopped, so it
      // gets the operator's warning but no delivery-log row — telling someone their disabled
      // webhook is "Blocked", once an hour, would report a problem they made on purpose.
      if (mapped.blocked !== null && subscription.enabled) blocked.push(mapped.blocked);
      if (mapped.target !== null) targets.push(mapped.target);
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

  return { targets, warnings, blocked };
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
