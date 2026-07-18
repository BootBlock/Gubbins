/**
 * The **synthetic test event** behind `POST /api/v1/webhooks/test` (webhooks plan `W7`; see
 * `docs/todo/done/webhooks_2026-07-18.md` §5.5).
 *
 * "Send test event" exists so a user can find out whether their subscription works *before* an
 * inventory change happens to match it. The whole value of that is in it being the **real** path —
 * the real matcher, the real template engine, the real SSRF guard, the real deliverer, a real
 * delivery-log row — with only the event itself synthesised. A shortcut that bypassed any of those
 * would produce a green tick for a subscription that never delivers, which is worse than no button.
 *
 * ## Which event type, and why it comes from the subscription
 *
 * The type is taken from the subscription's **own** `eventTypes` (its first entry, or
 * `item.changed` for the `*` wildcard). Picking a fixed type instead would make the test fail for
 * every subscription that did not happen to want it, which tells the user nothing about their
 * configuration. Taking it from the subscription guarantees the *type* gate passes, so what the
 * test actually exercises is everything after it — the filter, the destination, the transport.
 *
 * The **filter still genuinely applies**. A subscription narrowed to a location or a tag will
 * legitimately not match this event (it is about no real item), and the endpoint reports that as
 * `unmatched` rather than forcing a send. That is a true answer about a real rule, and the `W7` UI
 * says so plainly; quietly bypassing the matcher would be the misleading alternative.
 *
 * ## It is marked as a test, in the payload
 *
 * `data.label` / `data.detail` say so in words, and the item id is a fixed sentinel that matches no
 * real row. A receiver — and a human reading their own logs — must be able to tell this apart from
 * a real inventory change without consulting the bridge.
 *
 * Pure: no DB, no network; the id and timestamp are injectable so it tests directly. Imported by
 * the bridge, so it must survive Node's **strip-only** loader: no `enum`, no `namespace`, no TS
 * parameter properties.
 */
import { randomUUID } from 'node:crypto';
import type { IDatabaseDriver } from '@/db/rpc/driver';
import type { HistoryAction } from '@/db/repositories/constants.ts';
import { ACTION_EVENT_TYPE, ITEM_CHANGED_TYPE } from '@/features/events/event-types.ts';
import { WEBHOOK_ALL_EVENTS } from '@/features/webhooks/subscription.ts';
import { activityKindForAction } from '@/features/activity/activity-kind.ts';
import type { BridgeEvent, LedgerEvent } from './model.ts';
import { createWebhookDeliverer, type FetchLike } from './webhook.ts';
import type { WebhookDeliveryLog, WebhookDeliveryRecord } from './webhook-log.ts';
import type { WebhookDeliveryTarget } from './webhook-targets.ts';
import type { WebhookHostResolver, WebhookSsrfPolicy } from './webhook-ssrf.ts';

/** The item id a test event carries. Deliberately not a real row's id, and obviously not one. */
export const TEST_EVENT_ITEM_ID = 'gubbins-test-event';

/** The ledger action a test event reports when its type maps to no action at all. */
const TEST_EVENT_FALLBACK_ACTION: HistoryAction = 'ATTRIBUTES_CHANGED';

/**
 * The type a test event for this subscription should carry: its first subscribed type, or
 * {@link ITEM_CHANGED_TYPE} when it subscribes to everything (`['*']`) — the generic type a
 * wildcard subscriber is guaranteed to want, and the one the app's own catalogue leads with.
 *
 * An empty list also falls back rather than throwing. It is reachable from a corrupt synced row,
 * and the matcher will refuse it anyway (an empty list matches nothing), so the honest outcome is
 * an `unmatched` result the user can act on — not a 500.
 */
export function testEventTypeFor(eventTypes: readonly string[]): string {
  const first = eventTypes[0];
  if (first === undefined || first === WEBHOOK_ALL_EVENTS) return ITEM_CHANGED_TYPE;
  return first;
}

/**
 * The ledger action to report alongside a test event of this type.
 *
 * Reverse-looked-up from the published action → type table so the payload is internally coherent
 * (`stock.adjusted` arrives with a stock action, not an unrelated one). A type with no action
 * behind it — a derived status type such as `item.low_stock`, or a type from a newer catalogue —
 * falls back to the generic attribute edit.
 */
export function testEventActionFor(type: string): HistoryAction {
  for (const [action, mapped] of Object.entries(ACTION_EVENT_TYPE)) {
    if (mapped === type) return action as HistoryAction;
  }
  return TEST_EVENT_FALLBACK_ACTION;
}

/** Injectable non-determinism, so the builder is a pure function under test. */
export interface WebhookTestEventOptions {
  /** The event id (defaults to a `test:`-prefixed UUID — unmistakable in a delivery log). */
  readonly id?: string;
  /** Epoch-ms the event claims to have occurred (defaults to now). */
  readonly at?: number;
}

/**
 * Build the synthetic event for a subscription with these `eventTypes`.
 *
 * `data.item` is `null` — there is no real item, and inventing one would put a fabricated name and
 * location into the user's receiver and into any rendered template. `W3` already has one documented
 * rule for an event with no item: a narrowing filter refuses to match what it cannot confirm, and a
 * template placeholder renders empty. Reusing that rule is what keeps the test honest.
 */
export function buildWebhookTestEvent(
  eventTypes: readonly string[],
  options: WebhookTestEventOptions = {},
): LedgerEvent {
  const type = testEventTypeFor(eventTypes);
  const action = testEventActionFor(type);
  return {
    id: options.id ?? `test:${randomUUID()}`,
    type,
    occurredAt: new Date(options.at ?? Date.now()).toISOString(),
    data: {
      itemId: TEST_EVENT_ITEM_ID,
      itemName: 'Gubbins test event',
      action,
      kind: activityKindForAction(action),
      label: 'Test event',
      detail:
        'This is a test event sent from Gubbins to check this webhook subscription. ' +
        'It describes no real item and no real inventory change.',
      delta: null,
      quantityDelta: null,
      netValueDelta: null,
      item: null,
    },
  };
}

/** How the endpoint fires a test: one event, one target, resolving once the delivery has finished. */
export type WebhookTestFirer = (
  target: WebhookDeliveryTarget,
  event: BridgeEvent,
  driver: IDatabaseDriver,
) => Promise<WebhookDeliveryRecord | null>;

export interface WebhookTestFirerOptions {
  /** The delivery log the app polls; the test's row must land in it like any other. */
  readonly deliveryLog: WebhookDeliveryLog;
  /** The SSRF policy (defaults, as everywhere, to the guarded posture). */
  readonly ssrfPolicy?: WebhookSsrfPolicy;
  /** Injectable DNS resolver for the SSRF guard, so tests never touch the network. */
  readonly hostResolver?: WebhookHostResolver;
  /** Injectable transport (defaults to the global `fetch`). */
  readonly fetchImpl?: FetchLike;
  /** Optional log sink for delivery diagnostics. Never receives secrets. */
  readonly log?: (message: string) => void;
}

/**
 * Build the test-fire function: deliver one synthetic event to exactly one subscription through the
 * real delivery path, and resolve with the delivery-log row it wrote — or `null` when the matcher
 * excluded the event and nothing was sent.
 *
 * Four deliberate choices:
 *
 *   - **A fresh deliverer per fire.** The pipeline's deliverer fans an event out to *every*
 *     matching subscription; a test must reach exactly the one the user asked about, and
 *     `resolveTargets` is the seam that says so. A fresh one also starts with a closed failure
 *     circuit, so a subscription that has been failing is still actually tried — which is the whole
 *     point of pressing the button.
 *   - **One attempt.** The retry ladder exists so a real event survives a receiver's bad minute; a
 *     person waiting on an HTTP response wants the answer, and five attempts with backoff would
 *     outlive the request timeout. This is *how many times to try*, not what the rules are —
 *     everything that decides whether a delivery happens at all is untouched.
 *   - **The real SSRF guard.** This endpoint is a request-forgery primitive held back only by the
 *     bearer token, so the guard is not optional and is never short-circuited; a refusal comes back
 *     as a `blocked` row carrying the reason.
 *   - **The shared log, via a tee.** The row must land in the log the app polls, *and* the caller
 *     must know which row was this fire's. Reading the log back by sequence number afterwards would
 *     race a concurrent real delivery; capturing the record as it is written cannot.
 */
export function createWebhookTestFirer(options: WebhookTestFirerOptions): WebhookTestFirer {
  return async (target, event, driver) => {
    let recorded: WebhookDeliveryRecord | null = null;
    const tee: WebhookDeliveryLog = {
      record: (input) => {
        const stored = options.deliveryLog.record(input);
        recorded = stored;
        return stored;
      },
      list: (listOptions) => options.deliveryLog.list(listOptions),
      latestSeq: () => options.deliveryLog.latestSeq(),
    };

    const deliverer = createWebhookDeliverer({
      resolveTargets: () => Promise.resolve([target]),
      deliveryLog: tee,
      maxAttempts: 1,
      ...(options.ssrfPolicy !== undefined ? { ssrfPolicy: options.ssrfPolicy } : {}),
      ...(options.hostResolver !== undefined ? { hostResolver: options.hostResolver } : {}),
      ...(options.fetchImpl !== undefined ? { fetchImpl: options.fetchImpl } : {}),
      ...(options.log !== undefined ? { log: options.log } : {}),
    });
    await deliverer.deliver([event], driver);
    await deliverer.whenIdle(); // `deliver` resolves on intake only; the row exists after this
    return recorded;
  };
}
