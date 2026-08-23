/**
 * Delivery-log tests (webhooks plan `W5`, §3.1).
 *
 * The log is the app's only window onto what its subscriptions actually did — the bridge cannot
 * write outcomes back into a snapshot that is swapped wholesale on every hydration — so the
 * polling contract (`since` / `latestSeq`) and the containment rules (truncation, no secrets) are
 * what these tests pin.
 */
import { describe, expect, it } from 'vitest';
import {
  createWebhookDeliveryLog,
  MAX_DELIVERY_DETAIL_LENGTH,
  MAX_DELIVERY_LOG_PAGE,
  type WebhookDeliveryInput,
} from './webhook-log.ts';

function delivery(overrides: Partial<WebhookDeliveryInput> = {}): WebhookDeliveryInput {
  return {
    targetId: 'target-1',
    targetName: 'Workshop notifier',
    source: 'database',
    url: 'https://hooks.example.test/inventory',
    method: 'POST',
    eventId: 'hist-0001',
    eventType: 'item.low_stock',
    outcome: 'delivered',
    attempts: 1,
    status: 204,
    detail: null,
    ...overrides,
  };
}

describe('createWebhookDeliveryLog', () => {
  it('assigns a monotonic seq and the injected timestamp', () => {
    const log = createWebhookDeliveryLog({ now: () => 1_751_000_000_000 });
    expect(log.record(delivery()).seq).toBe(1);
    expect(log.record(delivery()).seq).toBe(2);
    expect(log.latestSeq()).toBe(2);
    expect(log.list()[0]!.at).toBe(1_751_000_000_000);
  });

  /**
   * Issue #645. The log is in memory, so a restart is a *new* log whose `seq` counts from one
   * again. A poller that cannot tell the two apart silently skips everything the new log recorded
   * before its next poll, so each instance identifies itself.
   */
  it('mints a distinct id per log instance and keeps it for that instance', () => {
    const first = createWebhookDeliveryLog();
    const second = createWebhookDeliveryLog();

    expect(first.logId()).not.toBe('');
    expect(first.logId()).toBe(first.logId());
    expect(second.logId()).not.toBe(first.logId());
    // The ids differ even though both logs number their records identically.
    expect(first.record(delivery()).seq).toBe(second.record(delivery()).seq);
  });

  it('returns records newest first', () => {
    const log = createWebhookDeliveryLog();
    log.record(delivery({ eventId: 'a' }));
    log.record(delivery({ eventId: 'b' }));
    expect(log.list().map((r) => r.eventId)).toEqual(['b', 'a']);
  });

  it('honours `since`, which is the polling form the app uses', () => {
    const log = createWebhookDeliveryLog();
    log.record(delivery({ eventId: 'a' }));
    const second = log.record(delivery({ eventId: 'b' }));
    log.record(delivery({ eventId: 'c' }));

    expect(log.list({ since: second.seq }).map((r) => r.eventId)).toEqual(['c']);
    // Nothing new since the latest: an empty page, not a repeat of the buffer.
    expect(log.list({ since: log.latestSeq() })).toEqual([]);
  });

  it('evicts oldest-first once the retention size is reached', () => {
    const log = createWebhookDeliveryLog({ size: 3 });
    for (const id of ['a', 'b', 'c', 'd']) log.record(delivery({ eventId: id }));
    expect(log.list().map((r) => r.eventId)).toEqual(['d', 'c', 'b']);
    // `seq` keeps counting past eviction, so a poller's cursor stays meaningful.
    expect(log.latestSeq()).toBe(4);
  });

  it('clamps `limit` to the page maximum and returns the newest within it', () => {
    const log = createWebhookDeliveryLog({ size: 500 });
    for (let i = 0; i < 250; i++) log.record(delivery({ eventId: `e${i}` }));
    expect(log.list({ limit: 2 }).map((r) => r.eventId)).toEqual(['e249', 'e248']);
    expect(log.list({ limit: 10_000 })).toHaveLength(MAX_DELIVERY_LOG_PAGE);
  });

  it('truncates an over-long detail so a receiver cannot grow the log unbounded', () => {
    const log = createWebhookDeliveryLog();
    const stored = log.record(delivery({ outcome: 'failed', detail: 'x'.repeat(1_000) }));
    expect(stored.detail).toHaveLength(MAX_DELIVERY_DETAIL_LENGTH + 1); // + the ellipsis marker
    expect(stored.detail?.endsWith('…')).toBe(true);
  });

  it('normalises a blank detail to null rather than storing whitespace', () => {
    const log = createWebhookDeliveryLog();
    expect(log.record(delivery({ detail: '   ' })).detail).toBeNull();
  });

  it('records the four outcomes distinctly', () => {
    const log = createWebhookDeliveryLog();
    for (const outcome of ['delivered', 'failed', 'blocked', 'skipped'] as const) {
      log.record(delivery({ outcome }));
    }
    expect(log.list().map((r) => r.outcome)).toEqual(['skipped', 'blocked', 'failed', 'delivered']);
  });
});
