/**
 * Outbound webhook tests (EI-1). Delivery is driven with an injected fake transport + no-op
 * sleep for determinism, plus one real in-process receiver that verifies the HMAC signature
 * end-to-end. Everything synthetic (example.test hosts, made-up secrets).
 */
import { createServer, type Server } from 'node:http';
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BridgeEvent } from './model.ts';
import {
  backoffFor,
  createWebhookDeliverer,
  DELIVERY_HEADER,
  EVENT_TYPE_HEADER,
  parseWebhookTargets,
  SIGNATURE_HEADER,
  signBody,
  targetWantsType,
  type FetchLike,
  type WebhookTarget,
} from './webhook.ts';

function event(overrides: Partial<BridgeEvent> & { id: string; type: string }): BridgeEvent {
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
      calls.push({ url, headers: init.headers, body: init.body });
      return { ok: true, status: 200 };
    };
    const deliverer = createWebhookDeliverer({
      targets: [{ url: 'https://a.example.test/hook', secret: 'topsecret' }],
      fetchImpl,
      sleep: noSleep,
      newDeliveryId: () => 'delivery-123',
    });
    deliverer.deliver([event({ id: 'e1', type: 'item.low_stock' })]);
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
      targets: [{ url: 'https://a.example.test/hook', secret: 's' }],
      fetchImpl,
      sleep,
      maxAttempts: 5,
    });
    deliverer.deliver([event({ id: 'e1', type: 'stock.adjusted' })]);
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
      targets: [{ url: 'https://dead.example.test/hook', secret: 's' }],
      fetchImpl,
      sleep: noSleep,
      now: () => 0, // clock frozen → cooldown never elapses
      maxAttempts: 1,
      circuitThreshold: 2,
      circuitCooldownMs: 1_000,
    });
    deliverer.deliver(Array.from({ length: 5 }, (_, i) => event({ id: `e${i}`, type: 'stock.adjusted' })));
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
      targets: [
        { url: 'https://dead.example.test/hook', secret: 's' },
        { url: 'https://good.example.test/hook', secret: 's' },
      ],
      fetchImpl,
      sleep: noSleep,
      maxAttempts: 1,
    });
    deliverer.deliver(Array.from({ length: 3 }, (_, i) => event({ id: `e${i}`, type: 'stock.adjusted' })));
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
      targets: [{ url: 'https://a.example.test/hook', secret: 's', events: ['item.low_stock'] }],
      fetchImpl,
      sleep: noSleep,
    });
    deliverer.deliver([
      event({ id: 'e1', type: 'stock.adjusted' }),
      event({ id: 'e2', type: 'item.low_stock' }),
    ]);
    await deliverer.whenIdle();
    expect(got).toEqual(['item.low_stock']);
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
      targets: [{ url: `http://127.0.0.1:${port}/hook`, secret }],
      sleep: noSleep,
    });
    deliverer.deliver([event({ id: 'e1', type: 'item.low_stock' })]);

    const result = await received;
    await deliverer.whenIdle();
    expect(result.ok).toBe(true);
    expect(result.type).toBe('item.low_stock');
  });
});
