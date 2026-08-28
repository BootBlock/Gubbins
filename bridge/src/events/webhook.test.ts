/**
 * Outbound webhook tests (EI-1). Delivery is driven with an injected fake transport + no-op
 * sleep for determinism, plus one real in-process receiver that verifies the HMAC signature
 * end-to-end. Everything synthetic (example.test hosts, made-up secrets).
 *
 * `void deliverer.deliver(...)` throughout is deliberate, not an oversight: `deliver` returns the
 * intake promise, and the sync point these tests actually want is the `await deliverer.whenIdle()`
 * on the next line — it waits for every in-flight intake *and* for the queued network half. The
 * `void` says so out loud, and keeps `no-floating-promises` (which covers the bridge, tests
 * included) able to flag a delivery that genuinely is left dangling.
 */
import { createServer, type Server } from 'node:http';
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BridgeEvent, LedgerEvent } from './model.ts';
import {
  backoffFor,
  buildWebhookRequest,
  createWebhookDeliverer,
  DELIVERY_HEADER,
  EVENT_TYPE_HEADER,
  isRedirect,
  MAX_RESPONSE_BODY_BYTES,
  parseWebhookTargets,
  readBoundedText,
  REDIRECT_DETAIL,
  SIGNATURE_HEADER,
  signBody,
  targetWantsType,
  type FetchLike,
  type WebhookTarget,
} from './webhook.ts';
import { createWebhookDeliveryLog } from './webhook-log.ts';
import type { WebhookDeliveryTarget } from './webhook-targets.ts';
import type { WebhookEventView } from '@/features/webhooks/event-view.ts';

function event(overrides: Partial<LedgerEvent> & { id: string; type: string }): BridgeEvent {
  return {
    occurredAt: '2025-06-27T06:13:20.000Z',
    data: {
      itemId: 'item-1',
      itemName: 'Widget',
      action: 'QUANTITY_CHANGE',
      kind: 'stock',
      label: 'Quantity changed',
      detail: null,
      delta: '−1',
      quantityDelta: -1,
      netValueDelta: null,
      item: null,
    },
    ...overrides,
  };
}

const noSleep = (): Promise<void> => Promise.resolve();

/**
 * A fake DNS resolver mapping every synthetic `example.test` host to one public address.
 *
 * The `W5` SSRF guard resolves any non-literal host and refuses a destination it cannot classify —
 * so without this, every test below would be `blocked` rather than delivered, because `.test` names
 * deliberately do not resolve. Injecting it keeps these tests offline **and** keeps them testing
 * delivery rather than accidentally re-testing the guard (which `webhook-ssrf.test.ts` covers).
 */
const publicResolver = (): Promise<readonly string[]> => Promise.resolve(['203.0.113.10']);

describe('signBody', () => {
  it('produces a verifiable sha256= HMAC over the raw body', () => {
    const body = JSON.stringify({ hello: 'world' });
    const sig = signBody('shhh', body);
    const expected = `sha256=${createHmac('sha256', 'shhh').update(body, 'utf8').digest('hex')}`;
    expect(sig).toBe(expected);
  });
});

describe('parseWebhookTargets', () => {
  it('accepts a bare array and a { targets: [...] } wrapper', () => {
    const bare = parseWebhookTargets([{ url: 'https://a.example.test/hook', secret: 's' }]);
    expect(bare).toEqual([{ url: 'https://a.example.test/hook', secret: 's' }]);
    const wrapped = parseWebhookTargets({
      targets: [{ url: 'http://b.example.test', secret: 's2', events: ['item.created'] }],
    });
    expect(wrapped[0]!.events).toEqual(['item.created']);
  });

  it('rejects a non-array, a bad url, an empty secret, and a non-string events list', () => {
    expect(() => parseWebhookTargets(42)).toThrow(/array/i);
    expect(() => parseWebhookTargets([{ url: 'ftp://x', secret: 's' }])).toThrow(/url/i);
    expect(() => parseWebhookTargets([{ url: 'https://x.example.test', secret: '' }])).toThrow(/secret/i);
    expect(() => parseWebhookTargets([{ url: 'https://x.example.test', secret: 's', events: [1] }])).toThrow(
      /events/i,
    );
  });
});

describe('targetWantsType', () => {
  const target: WebhookTarget = { url: 'https://x.example.test', secret: 's', events: ['item.low_stock'] };
  it('honours the filter, with no filter and "*" meaning all', () => {
    expect(targetWantsType(target, 'item.low_stock')).toBe(true);
    expect(targetWantsType(target, 'stock.adjusted')).toBe(false);
    expect(targetWantsType({ url: 'x', secret: 's' }, 'anything')).toBe(true);
    expect(targetWantsType({ url: 'x', secret: 's', events: ['*'] }, 'anything')).toBe(true);
  });
});

describe('backoffFor', () => {
  it('grows exponentially and is capped', () => {
    expect(backoffFor(1, 500, 30_000)).toBe(500);
    expect(backoffFor(2, 500, 30_000)).toBe(1_000);
    expect(backoffFor(3, 500, 30_000)).toBe(2_000);
    expect(backoffFor(20, 500, 30_000)).toBe(30_000);
  });
});

describe('createWebhookDeliverer', () => {
  it('signs the body, sets the delivery + event headers, and delivers once on success', async () => {
    const calls: Array<{ url: string; headers: Record<string, string>; body: string }> = [];
    const fetchImpl: FetchLike = async (url, init) => {
      calls.push({ url, headers: init.headers, body: init.body ?? '' });
      return { ok: true, status: 200 };
    };
    const deliverer = createWebhookDeliverer({
      hostResolver: publicResolver,
      targets: [{ url: 'https://a.example.test/hook', secret: 'topsecret' }],
      fetchImpl,
      sleep: noSleep,
      newDeliveryId: () => 'delivery-123',
    });
    void deliverer.deliver([event({ id: 'e1', type: 'item.low_stock' })]);
    await deliverer.whenIdle();

    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    expect(call.headers[SIGNATURE_HEADER]).toBe(signBody('topsecret', call.body));
    expect(call.headers[DELIVERY_HEADER]).toBe('delivery-123');
    expect(call.headers[EVENT_TYPE_HEADER]).toBe('item.low_stock');
  });

  it('retries with backoff then succeeds (at-least-once)', async () => {
    let attempts = 0;
    const sleep = vi.fn(noSleep);
    const fetchImpl: FetchLike = async () => {
      attempts++;
      if (attempts < 3) throw new Error('connection refused');
      return { ok: true, status: 200 };
    };
    const deliverer = createWebhookDeliverer({
      hostResolver: publicResolver,
      targets: [{ url: 'https://a.example.test/hook', secret: 's' }],
      fetchImpl,
      sleep,
      maxAttempts: 5,
    });
    void deliverer.deliver([event({ id: 'e1', type: 'stock.adjusted' })]);
    await deliverer.whenIdle();
    expect(attempts).toBe(3);
    expect(sleep).toHaveBeenCalledTimes(2); // one wait before each retry
  });

  it('opens a per-target circuit after repeated failures so a dead URL stops being hammered', async () => {
    let calls = 0;
    const fetchImpl: FetchLike = async () => {
      calls++;
      return { ok: false, status: 500 };
    };
    const deliverer = createWebhookDeliverer({
      hostResolver: publicResolver,
      targets: [{ url: 'https://dead.example.test/hook', secret: 's' }],
      fetchImpl,
      sleep: noSleep,
      now: () => 0, // clock frozen → cooldown never elapses
      maxAttempts: 1,
      circuitThreshold: 2,
      circuitCooldownMs: 1_000,
    });
    void deliverer.deliver(
      Array.from({ length: 5 }, (_, i) => event({ id: `e${i}`, type: 'stock.adjusted' })),
    );
    await deliverer.whenIdle();
    // Two failures trip the circuit; the remaining three are skipped without a fetch.
    expect(calls).toBe(2);
  });

  it('isolates targets — one dead URL does not stop the others', async () => {
    let good = 0;
    const fetchImpl: FetchLike = async (url) => {
      if (url.includes('good')) {
        good++;
        return { ok: true, status: 200 };
      }
      return { ok: false, status: 502 };
    };
    const deliverer = createWebhookDeliverer({
      hostResolver: publicResolver,
      targets: [
        { url: 'https://dead.example.test/hook', secret: 's' },
        { url: 'https://good.example.test/hook', secret: 's' },
      ],
      fetchImpl,
      sleep: noSleep,
      maxAttempts: 1,
    });
    void deliverer.deliver(
      Array.from({ length: 3 }, (_, i) => event({ id: `e${i}`, type: 'stock.adjusted' })),
    );
    await deliverer.whenIdle();
    expect(good).toBe(3);
  });

  it('only delivers the types a target subscribes to', async () => {
    const got: string[] = [];
    const fetchImpl: FetchLike = async (_url, init) => {
      got.push(init.headers[EVENT_TYPE_HEADER]!);
      return { ok: true, status: 200 };
    };
    const deliverer = createWebhookDeliverer({
      hostResolver: publicResolver,
      targets: [{ url: 'https://a.example.test/hook', secret: 's', events: ['item.low_stock'] }],
      fetchImpl,
      sleep: noSleep,
    });
    void deliverer.deliver([
      event({ id: 'e1', type: 'stock.adjusted' }),
      event({ id: 'e2', type: 'item.low_stock' }),
    ]);
    await deliverer.whenIdle();
    expect(got).toEqual(['item.low_stock']);
  });
});

// --- W5: the extended target model and request builder ----------------------------

describe('buildWebhookRequest (W5)', () => {
  const view: WebhookEventView = {
    id: 'hist-1',
    type: 'item.low_stock',
    occurredAt: '2025-06-27T06:13:20.000Z',
    item: {
      id: 'item-1',
      name: 'Widget',
      quantity: 2,
      locationId: 'loc-1',
      locationName: 'Shelf 2',
      locationPath: ['loc-root', 'loc-1'],
      categoryId: 'cat-1',
      categoryName: 'Electronics',
      tagIds: ['tag-1'],
    },
    change: {
      action: 'QUANTITY_CHANGE',
      kind: 'stock',
      label: 'Quantity changed',
      detail: null,
      delta: '−1',
      quantityDelta: -1,
      netValueDelta: null,
    },
  };
  const evt = event({ id: 'hist-1', type: 'item.low_stock' });

  function target(overrides: Partial<WebhookDeliveryTarget> = {}): WebhookDeliveryTarget {
    return {
      id: 'w1',
      name: 'Test target',
      source: 'database',
      url: 'https://a.example.test/hook',
      method: 'POST',
      enabled: true,
      secret: null,
      eventTypes: ['*'],
      filter: null,
      template: null,
      headers: null,
      ...overrides,
    };
  }

  it('sends the event envelope UNCHANGED when there is no template (the EI-1 contract)', () => {
    const plan = buildWebhookRequest(target(), evt, view, 'd-1');
    expect(plan.body).toBe(JSON.stringify(evt));
    expect(plan.headers['content-type']).toBe('application/json; charset=utf-8');
  });

  it('omits the signature entirely for an unsigned target', () => {
    const plan = buildWebhookRequest(target(), evt, view, 'd-1');
    expect(plan.headers[SIGNATURE_HEADER]).toBeUndefined();
    // The delivery + event headers are still set — they are not the signature's job.
    expect(plan.headers[DELIVERY_HEADER]).toBe('d-1');
    expect(plan.headers[EVENT_TYPE_HEADER]).toBe('item.low_stock');
  });

  it('signs the body when a secret is present', () => {
    const plan = buildWebhookRequest(target({ secret: 'shhh' }), evt, view, 'd-1');
    expect(plan.headers[SIGNATURE_HEADER]).toBe(signBody('shhh', plan.body!));
  });

  it('honours a non-POST method', () => {
    expect(buildWebhookRequest(target({ method: 'PUT' }), evt, view, 'd-1').method).toBe('PUT');
    expect(buildWebhookRequest(target({ method: 'PATCH' }), evt, view, 'd-1').method).toBe('PATCH');
  });

  it('renders a preset template as JSON', () => {
    const plan = buildWebhookRequest(target({ template: 'preset:slack' }), evt, view, 'd-1');
    expect(JSON.parse(plan.body!)).toEqual({ text: 'Quantity changed: Widget (−1)' });
  });

  it('renders a custom template as text, with the right content type', () => {
    const plan = buildWebhookRequest(
      target({ template: '{{item.name}} is low ({{item.quantity}})' }),
      evt,
      view,
      'd-1',
    );
    expect(plan.body).toBe('Widget is low (2)');
    expect(plan.headers['content-type']).toBe('text/plain; charset=utf-8');
  });

  it('carries a subscription’s extra static headers', () => {
    const plan = buildWebhookRequest(target({ headers: { 'X-Custom': 'v' } }), evt, view, 'd-1');
    expect(plan.headers['X-Custom']).toBe('v');
  });

  it('never lets a subscription header override a computed one', () => {
    // A second, independent guard on top of the target-sourcing sanitiser: even a header that
    // somehow reached the target model cannot forge a signature or a delivery id.
    const plan = buildWebhookRequest(
      target({
        secret: 'shhh',
        headers: { [SIGNATURE_HEADER]: 'sha256=forged', [DELIVERY_HEADER]: 'forged', 'content-type': 'x' },
      }),
      evt,
      view,
      'd-1',
    );
    expect(plan.headers[SIGNATURE_HEADER]).toBe(signBody('shhh', plan.body!));
    expect(plan.headers[DELIVERY_HEADER]).toBe('d-1');
    expect(plan.headers['content-type']).toBe('application/json; charset=utf-8');
  });

  it('flattens the payload into the query string for GET, and sends no body or signature', () => {
    const plan = buildWebhookRequest(target({ method: 'GET', secret: 'shhh' }), evt, view, 'd-1');
    expect(plan.body).toBeUndefined();
    // A GET has no body, and an HMAC signs a body — so there is nothing to sign. The UI says so.
    expect(plan.headers[SIGNATURE_HEADER]).toBeUndefined();

    const url = new URL(plan.url);
    expect(url.searchParams.get('event.type')).toBe('item.low_stock');
    expect(url.searchParams.get('item.name')).toBe('Widget');
    // A query string cannot express null, so null-valued keys are dropped rather than sent as "null".
    expect(url.searchParams.has('change.detail')).toBe(false);
  });

  it('preserves an existing query string on a GET target URL', () => {
    const plan = buildWebhookRequest(
      target({ method: 'GET', url: 'https://a.example.test/hook?fixed=1' }),
      evt,
      view,
      'd-1',
    );
    const url = new URL(plan.url);
    expect(url.searchParams.get('fixed')).toBe('1');
    expect(url.searchParams.get('event.id')).toBe('hist-1');
  });
});

describe('createWebhookDeliverer with DB-sourced targets (W5)', () => {
  const evt = event({ id: 'hist-1', type: 'item.low_stock' });

  function dbTarget(overrides: Partial<WebhookDeliveryTarget> = {}): WebhookDeliveryTarget {
    return {
      id: 'w1',
      name: 'Workshop notifier',
      source: 'database',
      url: 'https://a.example.test/hook',
      method: 'POST',
      enabled: true,
      secret: null,
      eventTypes: ['*'],
      filter: null,
      template: null,
      headers: null,
      ...overrides,
    };
  }

  it('merges resolved targets with the operator’s configured ones', async () => {
    const urls: string[] = [];
    const deliverer = createWebhookDeliverer({
      hostResolver: publicResolver,
      targets: [{ url: 'https://config.example.test/hook', secret: 's' }],
      resolveTargets: async () => [dbTarget({ url: 'https://app.example.test/hook' })],
      fetchImpl: async (url) => {
        urls.push(url);
        return { ok: true, status: 200 };
      },
      sleep: noSleep,
    });
    void deliverer.deliver([evt]);
    await deliverer.whenIdle();
    expect(urls.sort()).toEqual(['https://app.example.test/hook', 'https://config.example.test/hook']);
  });

  it('does not deliver to a disabled subscription', async () => {
    let calls = 0;
    const deliverer = createWebhookDeliverer({
      hostResolver: publicResolver,
      resolveTargets: async () => [dbTarget({ enabled: false })],
      fetchImpl: async () => {
        calls++;
        return { ok: true, status: 200 };
      },
      sleep: noSleep,
    });
    void deliverer.deliver([evt]);
    await deliverer.whenIdle();
    expect(calls).toBe(0);
  });

  it('applies the subscription’s declarative filter', async () => {
    let calls = 0;
    const deliverer = createWebhookDeliverer({
      hostResolver: publicResolver,
      // The event carries item: null, so an item-scoped filter cannot confirm a match and must
      // narrow rather than wave it through — the W3 rule this delivery path must not soften.
      resolveTargets: async () => [dbTarget({ filter: { kind: 'category', categoryIds: ['cat-1'] } })],
      fetchImpl: async () => {
        calls++;
        return { ok: true, status: 200 };
      },
      sleep: noSleep,
    });
    void deliverer.deliver([evt]);
    await deliverer.whenIdle();
    expect(calls).toBe(0);
  });

  it('re-reads the targets on every batch, so a new subscription goes live without a restart', async () => {
    let generation = 0;
    const urls: string[] = [];
    const deliverer = createWebhookDeliverer({
      hostResolver: publicResolver,
      resolveTargets: async () =>
        generation === 0 ? [] : [dbTarget({ url: 'https://added.example.test/hook' })],
      fetchImpl: async (url) => {
        urls.push(url);
        return { ok: true, status: 200 };
      },
      sleep: noSleep,
    });
    void deliverer.deliver([evt]);
    await deliverer.whenIdle();
    expect(urls).toEqual([]);

    generation = 1;
    void deliverer.deliver([evt]);
    await deliverer.whenIdle();
    expect(urls).toEqual(['https://added.example.test/hook']);
  });

  it('keeps delivering to configured targets when the subscription read fails', async () => {
    const urls: string[] = [];
    const deliverer = createWebhookDeliverer({
      hostResolver: publicResolver,
      targets: [{ url: 'https://config.example.test/hook', secret: 's' }],
      resolveTargets: async () => {
        throw new Error('driver closed');
      },
      fetchImpl: async (url) => {
        urls.push(url);
        return { ok: true, status: 200 };
      },
      sleep: noSleep,
      log: () => undefined,
    });
    void deliverer.deliver([evt]);
    await deliverer.whenIdle();
    expect(urls).toEqual(['https://config.example.test/hook']);
  });
});

describe('the SSRF guard in the delivery path (W5, §6.2)', () => {
  const evt = event({ id: 'hist-1', type: 'item.low_stock' });

  it('refuses a private destination and issues NO request at all', async () => {
    let calls = 0;
    const log = createWebhookDeliveryLog();
    const deliverer = createWebhookDeliverer({
      targets: [{ url: 'http://192.168.1.50/hook', secret: 's' }],
      fetchImpl: async () => {
        calls++;
        return { ok: true, status: 200 };
      },
      sleep: noSleep,
      deliveryLog: log,
      log: () => undefined,
    });
    void deliverer.deliver([evt]);
    await deliverer.whenIdle();

    expect(calls).toBe(0);
    const record = log.list()[0]!;
    expect(record.outcome).toBe('blocked');
    expect(record.attempts).toBe(0);
    expect(record.detail).toMatch(/private/);
  });

  it('delivers to that same destination once the operator opts in', async () => {
    let calls = 0;
    const deliverer = createWebhookDeliverer({
      ssrfPolicy: { allowPrivate: true },
      targets: [{ url: 'http://192.168.1.50/hook', secret: 's' }],
      fetchImpl: async () => {
        calls++;
        return { ok: true, status: 200 };
      },
      sleep: noSleep,
    });
    void deliverer.deliver([evt]);
    await deliverer.whenIdle();
    expect(calls).toBe(1);
  });

  it('guards by default when no policy is passed at all', async () => {
    let calls = 0;
    const deliverer = createWebhookDeliverer({
      targets: [{ url: 'http://169.254.169.254/latest/meta-data/', secret: 's' }],
      fetchImpl: async () => {
        calls++;
        return { ok: true, status: 200 };
      },
      sleep: noSleep,
      log: () => undefined,
    });
    void deliverer.deliver([evt]);
    await deliverer.whenIdle();
    expect(calls).toBe(0);
  });

  it('does not let a blocked target trip its own failure circuit', async () => {
    // A misconfigured URL is not a transport fault; tripping the circuit would then suppress
    // delivery for a target that is otherwise perfectly healthy once the URL is fixed.
    const log = createWebhookDeliveryLog();
    const deliverer = createWebhookDeliverer({
      targets: [{ url: 'http://127.0.0.1/hook', secret: 's' }],
      fetchImpl: async () => ({ ok: true, status: 200 }),
      sleep: noSleep,
      circuitThreshold: 2,
      deliveryLog: log,
      log: () => undefined,
    });
    void deliverer.deliver(
      Array.from({ length: 4 }, (_, i) => event({ id: `e${i}`, type: 'item.low_stock' })),
    );
    await deliverer.whenIdle();
    // All four are individually refused; none is "skipped" by an opened circuit.
    expect(log.list().map((r) => r.outcome)).toEqual(['blocked', 'blocked', 'blocked', 'blocked']);
  });

  it('leaves an existing failure count untouched rather than resetting it', async () => {
    // A refusal is neither evidence the endpoint is healthy nor evidence it is failing. If it
    // *reset* the counter, a target that intermittently resolves private could never trip its
    // circuit, and a genuinely dead endpoint would be hammered forever.
    const log = createWebhookDeliveryLog();
    // The guard resolves a non-literal host on every job, so flipping what the name resolves to is
    // the honest way to interleave a blocked job between two real failures — and it models the
    // actual scenario (a hostname whose resolution changes under us).
    let resolvesPrivate = false;
    const deliverer = createWebhookDeliverer({
      hostResolver: () => Promise.resolve([resolvesPrivate ? '10.0.0.9' : '203.0.113.10']),
      targets: [{ url: 'https://flaky.example.test/hook', secret: 's' }],
      fetchImpl: async () => ({ ok: false, status: 500 }),
      sleep: noSleep,
      now: () => 0,
      maxAttempts: 1,
      circuitThreshold: 2,
      circuitCooldownMs: 1_000,
      deliveryLog: log,
      log: () => undefined,
    });

    resolvesPrivate = false;
    void deliverer.deliver([event({ id: 'e1', type: 'item.low_stock' })]);
    await deliverer.whenIdle();

    resolvesPrivate = true;
    void deliverer.deliver([event({ id: 'e2', type: 'item.low_stock' })]);
    await deliverer.whenIdle();

    resolvesPrivate = false;
    void deliverer.deliver([event({ id: 'e3', type: 'item.low_stock' })]);
    await deliverer.whenIdle();

    // fail, blocked, fail — the blocked job must not have reset the count, so the second real
    // failure reaches the threshold of 2 and trips the circuit.
    expect(log.list().map((r) => r.outcome)).toEqual(['failed', 'blocked', 'failed']);

    resolvesPrivate = false;
    void deliverer.deliver([event({ id: 'e4', type: 'item.low_stock' })]);
    await deliverer.whenIdle();
    expect(log.list()[0]!.outcome).toBe('skipped');
  });
});

describe('the delivery log in the delivery path (W5, §3.1)', () => {
  const evt = event({ id: 'hist-1', type: 'item.low_stock' });

  it('records a success with its status and attempt count', async () => {
    const log = createWebhookDeliveryLog();
    const deliverer = createWebhookDeliverer({
      hostResolver: publicResolver,
      targets: [{ url: 'https://a.example.test/hook', secret: 's' }],
      fetchImpl: async () => ({ ok: true, status: 204 }),
      sleep: noSleep,
      deliveryLog: log,
    });
    void deliverer.deliver([evt]);
    await deliverer.whenIdle();

    expect(log.list()[0]).toMatchObject({
      outcome: 'delivered',
      status: 204,
      attempts: 1,
      eventId: 'hist-1',
      eventType: 'item.low_stock',
      source: 'config',
      method: 'POST',
    });
  });

  it('records a failure after every attempt, keeping the receiver’s message', async () => {
    const log = createWebhookDeliveryLog();
    const deliverer = createWebhookDeliverer({
      hostResolver: publicResolver,
      targets: [{ url: 'https://a.example.test/hook', secret: 's' }],
      fetchImpl: async () => ({ ok: false, status: 500, body: 'upstream exploded' }),
      sleep: noSleep,
      maxAttempts: 2,
      deliveryLog: log,
      log: () => undefined,
    });
    void deliverer.deliver([evt]);
    await deliverer.whenIdle();

    expect(log.list()[0]).toMatchObject({
      outcome: 'failed',
      status: 500,
      attempts: 2,
      detail: 'upstream exploded',
    });
  });

  it('records a skip once the circuit is open', async () => {
    const log = createWebhookDeliveryLog();
    const deliverer = createWebhookDeliverer({
      hostResolver: publicResolver,
      targets: [{ url: 'https://dead.example.test/hook', secret: 's' }],
      fetchImpl: async () => ({ ok: false, status: 500 }),
      sleep: noSleep,
      now: () => 0,
      maxAttempts: 1,
      circuitThreshold: 1,
      circuitCooldownMs: 1_000,
      deliveryLog: log,
      log: () => undefined,
    });
    void deliverer.deliver([
      event({ id: 'e1', type: 'item.low_stock' }),
      event({ id: 'e2', type: 'item.low_stock' }),
    ]);
    await deliverer.whenIdle();

    expect(log.list().map((r) => r.outcome)).toEqual(['skipped', 'failed']);
  });

  it('records the URL with its query string dropped', async () => {
    const log = createWebhookDeliveryLog();
    const deliverer = createWebhookDeliverer({
      hostResolver: publicResolver,
      // A GET delivery fills the query with payload data, which is exactly why it is not recorded.
      resolveTargets: async () => [
        {
          id: 'w1',
          name: 'A',
          source: 'database' as const,
          url: 'https://a.example.test/hook?token=super-secret',
          method: 'GET' as const,
          enabled: true,
          secret: null,
          eventTypes: ['*'],
          filter: null,
          template: null,
          headers: null,
        },
      ],
      fetchImpl: async () => ({ ok: true, status: 200 }),
      sleep: noSleep,
      deliveryLog: log,
    });
    void deliverer.deliver([evt]);
    await deliverer.whenIdle();

    expect(log.list()[0]!.url).toBe('https://a.example.test/hook');
    expect(JSON.stringify(log.list())).not.toContain('super-secret');
  });

  it('never records a secret or a signature', async () => {
    const log = createWebhookDeliveryLog();
    const deliverer = createWebhookDeliverer({
      hostResolver: publicResolver,
      targets: [{ url: 'https://a.example.test/hook', secret: 'a-very-secret-value' }],
      fetchImpl: async () => ({ ok: true, status: 200 }),
      sleep: noSleep,
      deliveryLog: log,
    });
    void deliverer.deliver([evt]);
    await deliverer.whenIdle();

    const serialised = JSON.stringify(log.list());
    expect(serialised).not.toContain('a-very-secret-value');
    expect(serialised).not.toContain('sha256=');
  });
});

describe('end-to-end signature verification against a real receiver', () => {
  let server: Server | undefined;
  afterEach(async () => {
    if (server) await new Promise<void>((r) => server!.close(() => r()));
    server = undefined;
  });

  it('delivers a POST whose signature the receiver verifies', async () => {
    const secret = 'placeholder-signing-secret-for-tests';
    const received = new Promise<{ ok: boolean; type: string | undefined }>((resolve) => {
      server = createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on('data', (c: Buffer) => chunks.push(c));
        req.on('end', () => {
          const body = Buffer.concat(chunks).toString('utf8');
          const expected = signBody(secret, body);
          const got = req.headers[SIGNATURE_HEADER.toLowerCase()];
          const ok =
            typeof got === 'string' &&
            got.length === expected.length &&
            timingSafeEqual(Buffer.from(got), Buffer.from(expected));
          res.writeHead(ok ? 200 : 401).end();
          resolve({ ok, type: req.headers[EVENT_TYPE_HEADER.toLowerCase()] as string | undefined });
        });
      });
    });
    await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
    const { port } = server!.address() as AddressInfo;

    const deliverer = createWebhookDeliverer({
      // The receiver is a real in-process server on loopback, which the `W5` SSRF guard refuses by
      // default — so this end-to-end test is also the demonstration that the opt-in flag is what
      // makes a loopback destination reachable, and that nothing else does.
      ssrfPolicy: { allowPrivate: true },
      targets: [{ url: `http://127.0.0.1:${port}/hook`, secret }],
      sleep: noSleep,
    });
    void deliverer.deliver([event({ id: 'e1', type: 'item.low_stock' })]);

    const result = await received;
    await deliverer.whenIdle();
    expect(result.ok).toBe(true);
    expect(result.type).toBe('item.low_stock');
  });
});

// --- #494: a redirect must not carry a delivery past the SSRF guard -----------------

describe('redirects (#494)', () => {
  const evt = event({ id: 'hist-1', type: 'item.low_stock' });

  it('classifies only 3xx as a redirect', () => {
    expect([300, 301, 302, 303, 307, 308, 399].filter((s) => !isRedirect(s))).toEqual([]);
    expect([200, 204, 299, 400, 404, 500].filter(isRedirect)).toEqual([]);
  });

  it('ends the delivery on a 3xx without retrying it', async () => {
    const log = createWebhookDeliveryLog();
    let calls = 0;
    const deliverer = createWebhookDeliverer({
      hostResolver: publicResolver,
      targets: [{ url: 'https://a.example.test/hook', secret: 's' }],
      fetchImpl: async () => {
        calls += 1;
        return { ok: false, status: 307, body: 'moved' };
      },
      sleep: noSleep,
      maxAttempts: 5,
      deliveryLog: log,
      log: () => undefined,
    });
    void deliverer.deliver([evt]);
    await deliverer.whenIdle();

    // One attempt, not five: a receiver that redirects will redirect again.
    expect(calls).toBe(1);
    expect(log.list()[0]).toMatchObject({ outcome: 'failed', status: 307, attempts: 1 });
    // Our own wording, so the receiver cannot choose what the operator reads.
    expect(log.list()[0]!.detail).toBe(REDIRECT_DETAIL);
    expect(log.list()[0]!.detail).not.toContain('moved');
  });

  it('does not follow a real receiver’s 307 to a second address', async () => {
    let redirected = 0;
    let followed = 0;
    const server = createServer((req, res) => {
      if (req.url === '/final') {
        followed += 1;
        res.writeHead(200).end();
        return;
      }
      redirected += 1;
      // The shape that matters: a 307 preserves the method and the body, so following it would
      // re-issue the whole signed delivery at an address the SSRF guard never classified.
      res.writeHead(307, { location: `http://127.0.0.1:${port}/final` }).end('go here instead');
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const { port } = server.address() as AddressInfo;

    try {
      const log = createWebhookDeliveryLog();
      const deliverer = createWebhookDeliverer({
        // Loopback needs the opt-in, exactly as the end-to-end signature test does.
        ssrfPolicy: { allowPrivate: true },
        targets: [{ url: `http://127.0.0.1:${port}/hook`, secret: 'placeholder-signing-secret' }],
        sleep: noSleep,
        maxAttempts: 2,
        deliveryLog: log,
        log: () => undefined,
      });
      void deliverer.deliver([evt]);
      await deliverer.whenIdle();

      expect(redirected).toBe(1);
      expect(followed).toBe(0);
      expect(log.list()[0]).toMatchObject({ outcome: 'failed', status: 307, detail: REDIRECT_DETAIL });
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });
});

// --- #494: the response body is read through a byte cap ---------------------------

describe('readBoundedText (#494)', () => {
  it('stops at the cap and cancels a body that never ends', async () => {
    let cancelled = false;
    let pulls = 0;
    const chunk = new Uint8Array(1_024).fill(0x61); // 'a'
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls += 1;
        controller.enqueue(chunk);
      },
      cancel() {
        cancelled = true;
      },
    });

    const text = await readBoundedText(new Response(stream));

    expect(text).toHaveLength(MAX_RESPONSE_BODY_BYTES);
    expect(cancelled).toBe(true);
    // The point of the cap: a stream with no end still costs a bounded number of reads.
    expect(pulls).toBeLessThan(1_000);
  });

  it('returns a short body whole, and an empty body as an empty string', async () => {
    expect(await readBoundedText(new Response('upstream exploded'))).toBe('upstream exploded');
    expect(await readBoundedText(new Response(''))).toBe('');
  });

  it('returns undefined when there is no body at all', async () => {
    expect(await readBoundedText(new Response(null, { status: 204 }))).toBeUndefined();
  });
});
