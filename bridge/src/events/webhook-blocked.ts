/**
 * Delivery-log rows for subscriptions the bridge **refuses to deliver at all** (issue #643).
 *
 * A subscription naming a `secret_ref` the bridge cannot resolve is dropped at target-resolution
 * time — correctly, since sending it unsigned would be worse — so it never reaches the deliverer,
 * and the deliverer is the only thing that writes to the delivery log. The result was a webhook
 * that silently stopped delivering while the app's log read *"Nothing delivered yet"*, which is
 * the same thing a perfectly healthy webhook that has not fired yet says. Both the subscription
 * editor's own copy and the wiki promised the opposite: that such attempts show as **Blocked**.
 *
 * This module makes that promise true. Everything a row needs is already known where the refusal
 * happens, so the row is written from there rather than from a delivery that never starts.
 *
 * ## Why it is throttled, and not written once per event
 *
 * Targets are re-resolved **once per event batch**, so recording on every refusal would bury the
 * rest of the log under one misconfiguration. Recording only the very first would be worse in the
 * other direction: the log is a bounded ring, so on a busy bridge the one row explaining the
 * problem is eventually evicted and the screen returns to saying nothing is wrong. So a
 * still-blocked subscription is re-recorded at most once per {@link DEFAULT_BLOCKED_REPEAT_MS}, and
 * a subscription whose refusal *reason* changes is recorded again immediately — that is new
 * information, not a repeat.
 *
 * Nothing here logs a secret: the reason names the missing ref's *name* only, and the URL goes
 * through the deliverer's own `redactUrl`, so no query string is ever recorded.
 *
 * Imported by the bridge, so it must survive Node's **strip-only** loader: no `enum`, no
 * `namespace`, no TS parameter properties.
 */
import type { WebhookDeliveryLog } from './webhook-log.ts';
import type { WebhookBlockedSubscription } from './webhook-targets.ts';
import { redactUrl } from './webhook.ts';

/** How long a still-blocked subscription stays quiet before it is recorded again (1 hour). */
export const DEFAULT_BLOCKED_REPEAT_MS = 60 * 60 * 1000;

export interface BlockedSubscriptionReporterOptions {
  /** Where the rows go. Absent means the bridge has no delivery log, and reporting is a no-op. */
  readonly deliveryLog?: WebhookDeliveryLog;
  /** Injectable clock (defaults to `Date.now`). */
  readonly now?: () => number;
  /** Override the repeat interval (defaults to {@link DEFAULT_BLOCKED_REPEAT_MS}). */
  readonly repeatAfterMs?: number;
}

export interface BlockedSubscriptionReporter {
  /**
   * Record the currently-blocked subscriptions, honouring the throttle. Call with the **whole**
   * current list each time: a subscription that has stopped being blocked is forgotten, so if it
   * breaks again later it is reported immediately rather than waiting out an old interval.
   */
  report(blocked: readonly WebhookBlockedSubscription[]): void;
}

interface ReportedRefusal {
  readonly reason: string;
  readonly at: number;
}

/**
 * Create the reporter that turns refused subscriptions into `blocked` delivery-log rows.
 *
 * The state it keeps is one entry per currently-blocked subscription, rebuilt on every call, so it
 * cannot grow with time or outlive the subscriptions it describes.
 */
export function createBlockedSubscriptionReporter(
  options: BlockedSubscriptionReporterOptions = {},
): BlockedSubscriptionReporter {
  const deliveryLog = options.deliveryLog;
  const now = options.now ?? Date.now;
  const repeatAfter = Math.max(0, options.repeatAfterMs ?? DEFAULT_BLOCKED_REPEAT_MS);
  let reported = new Map<string, ReportedRefusal>();

  return {
    report(blocked: readonly WebhookBlockedSubscription[]): void {
      const seen = new Map<string, ReportedRefusal>();
      for (const subscription of blocked) {
        // Keyed by id, not by the sentence: a rename of the missing ref is a different problem and
        // deserves its own row, and this is also what makes "still the same refusal" cheap to spot.
        const previous = reported.get(subscription.id);
        const at = now();
        const stale =
          previous === undefined ||
          previous.reason !== subscription.reason ||
          at - previous.at >= repeatAfter;
        if (!stale) {
          seen.set(subscription.id, previous);
          continue;
        }
        seen.set(subscription.id, { reason: subscription.reason, at });
        deliveryLog?.record({
          targetId: subscription.id,
          targetName: subscription.name,
          source: 'database',
          url: redactUrl(subscription.url),
          method: subscription.method,
          // No event was considered: the subscription was dropped before the matcher ever ran, and
          // naming a type here would assert an event that did not happen.
          eventId: '',
          eventType: '',
          outcome: 'blocked',
          attempts: 0,
          status: null,
          detail: subscription.reason,
        });
      }
      reported = seen;
    },
  };
}
