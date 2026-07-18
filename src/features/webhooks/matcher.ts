/**
 * Subscription **matching** — "should this event go to this subscription?" (webhooks plan `W3`;
 * see `docs/todo/webhooks_2026-07-18.md` §7).
 *
 * One decision, in one tested place, used by the only deliverer there is. The bridge asks this per
 * (event × subscription) pair; the app will ask the same question in `W7` to preview which recent
 * events *would* have matched, and the two must never disagree — which is precisely why the rule
 * lives here rather than inside the deliverer.
 *
 * The decision is three independent gates, in the order that rejects fastest and reads most
 * obviously: **enabled**, then **event type**, then **filter**.
 *
 * Pure: no DB, no clock, no network. Imported by the bridge, so it must survive Node's
 * **strip-only** loader: no `enum`, no `namespace`, no TS parameter properties.
 */
import type { WebhookEventView } from './event-view.ts';
import { evaluateWebhookFilter, type WebhookFilter } from './filter.ts';
import { WEBHOOK_ALL_EVENTS } from './subscription.ts';

/**
 * The part of a subscription that decides delivery.
 *
 * Structural rather than the full `WebhookSubscription` so both callers fit without adapting: the
 * bridge merges DB-sourced subscriptions with file/env targets (`W5`), and those file targets carry
 * no `createdAt`, `secretRef` or any of the rest. Nothing about *where* to deliver appears here —
 * this module answers whether, never how.
 */
export interface WebhookMatchTarget {
  readonly enabled: boolean;
  /** Dotted event types, or `['*']` for everything. */
  readonly eventTypes: readonly string[];
  /** A parsed filter, or `null` for "every event of the subscribed types". */
  readonly filter: WebhookFilter | null;
}

/**
 * Does a subscribed type list cover this event type?
 *
 * `*` is the **only** wildcard: it means "everything", and there is deliberately no prefix form
 * (`item.*`). A glob would be a second, weaker query language sitting beside the filter tree, and
 * it would quietly change meaning every time a new dotted type is added — a user who wrote
 * `item.*` to mean the four events that existed would start receiving ones they never saw. The
 * `W7` picker offers named types from the catalogue, where the set is explicit and visible.
 *
 * An empty list matches nothing. That is reachable from a corrupt synced row (`rowToWebhookSubscription`
 * softens a malformed `event_types` to `[]`), and matching nothing is the safe direction for
 * something that calls out to the network.
 */
export function eventTypeMatches(eventTypes: readonly string[], type: string): boolean {
  if (eventTypes.includes(WEBHOOK_ALL_EVENTS)) return true;
  return eventTypes.includes(type);
}

/**
 * The whole decision: is this event deliverable to this subscription?
 *
 * A disabled subscription matches nothing regardless of its types or filter — checked here rather
 * than left to each caller, so "disabled" cannot mean one thing on the bridge and another in the
 * app's preview.
 */
export function subscriptionMatches(target: WebhookMatchTarget, view: WebhookEventView): boolean {
  if (!target.enabled) return false;
  if (!eventTypeMatches(target.eventTypes, view.type)) return false;
  return evaluateWebhookFilter(target.filter, view);
}

/**
 * Every subscription an event should be delivered to, in the caller's order.
 *
 * The fan-out direction the deliverer actually wants: one event arrives, and it needs the list of
 * targets rather than to loop and test. Order is preserved so delivery is deterministic.
 */
export function matchingSubscriptions<T extends WebhookMatchTarget>(
  targets: readonly T[],
  view: WebhookEventView,
): readonly T[] {
  return targets.filter((target) => subscriptionMatches(target, view));
}
