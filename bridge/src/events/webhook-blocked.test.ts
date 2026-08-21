/**
 * Tests for the `blocked` delivery-log rows a refused subscription produces (issue #643).
 *
 * The behaviour that matters is the balance: a refusal must reach the app's delivery log, but a
 * subscription that is re-resolved on every event batch must not fill the bounded log with the same
 * sentence. Both directions are pinned here, as is the rule that no secret is ever recorded.
 */
import { describe, expect, it } from 'vitest';
import { createWebhookDeliveryLog } from './webhook-log.ts';
import { createBlockedSubscriptionReporter } from './webhook-blocked.ts';
import type { WebhookBlockedSubscription } from './webhook-targets.ts';

const BLOCKED: WebhookBlockedSubscription = {
  id: 'w1',
  name: 'Workshop notifier',
  url: 'https://hooks.example.test/inventory?token=should-not-be-logged',
  method: 'POST',
  reason:
    'Webhook "Workshop notifier" references a bridge-side secret named "discord" that is not configured.',
};

function harness(repeatAfterMs = 60_000) {
  let clock = 1_751_000_000_000;
  const log = createWebhookDeliveryLog();
  const reporter = createBlockedSubscriptionReporter({
    deliveryLog: log,
    now: () => clock,
    repeatAfterMs,
  });
  return { log, reporter, advance: (ms: number) => (clock += ms) };
}

describe('createBlockedSubscriptionReporter', () => {
  it('records a blocked row the app can show, with no event type asserted', () => {
    const { log, reporter } = harness();
    reporter.report([BLOCKED]);

    const [row] = log.list();
    expect(row).toMatchObject({
      targetId: 'w1',
      targetName: 'Workshop notifier',
      source: 'database',
      method: 'POST',
      outcome: 'blocked',
      attempts: 0,
      status: null,
      eventId: '',
      eventType: '',
    });
    expect(row!.detail).toContain('discord');
  });

  it('redacts the URL, so no query string reaches the log', () => {
    const { log, reporter } = harness();
    reporter.report([BLOCKED]);
    expect(log.list()[0]!.url).toBe('https://hooks.example.test/inventory');
  });

  it('does not repeat the same refusal on every event batch', () => {
    const { log, reporter, advance } = harness();
    reporter.report([BLOCKED]);
    advance(1_000);
    reporter.report([BLOCKED]);
    reporter.report([BLOCKED]);
    expect(log.list()).toHaveLength(1);
  });

  it('re-records a refusal that is still current once the interval has passed', () => {
    // The log is a bounded ring: recorded once and never again, the one row explaining a dead
    // webhook is eventually evicted and the screen goes back to saying nothing is wrong.
    const { log, reporter, advance } = harness(60_000);
    reporter.report([BLOCKED]);
    advance(60_000);
    reporter.report([BLOCKED]);
    expect(log.list()).toHaveLength(2);
  });

  it('records again immediately when the reason changes', () => {
    const { log, reporter } = harness();
    reporter.report([BLOCKED]);
    reporter.report([{ ...BLOCKED, reason: 'Webhook "Workshop notifier" names "workshop" instead.' }]);
    expect(log.list()).toHaveLength(2);
    expect(log.list()[0]!.detail).toContain('workshop');
  });

  it('forgets a subscription that is no longer blocked, so a relapse is reported at once', () => {
    const { log, reporter, advance } = harness(60_000);
    reporter.report([BLOCKED]);
    advance(1_000);
    reporter.report([]);
    advance(1_000);
    reporter.report([BLOCKED]);
    expect(log.list()).toHaveLength(2);
  });

  it('throttles each subscription independently', () => {
    const { log, reporter } = harness();
    const other = { ...BLOCKED, id: 'w2', name: 'Garage notifier' };
    reporter.report([BLOCKED, other]);
    reporter.report([BLOCKED, other]);
    expect(log.list()).toHaveLength(2);
    expect(
      log
        .list()
        .map((row) => row.targetId)
        .sort(),
    ).toEqual(['w1', 'w2']);
  });

  it('is a no-op when the bridge has no delivery log', () => {
    const reporter = createBlockedSubscriptionReporter();
    expect(() => reporter.report([BLOCKED])).not.toThrow();
  });
});
