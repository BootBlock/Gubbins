/**
 * End-to-end tests for `POST /api/v1/webhooks/test` (webhooks plan `W7`, §5.5), driving the real
 * bridge HTTP server in-process.
 *
 * The endpoint's whole value is that it is the **real** path — the real matcher, the real target
 * mapping, the real SSRF guard, the real deliverer, a real delivery-log row — with only the event
 * synthesised. So these tests pin the outcomes that prove each of those is actually in the way:
 * `unmatched` when the subscription's own filter excludes it, `blocked` when the guard refuses a
 * private destination, and `delivered` (with a log `seq`) when it genuinely goes out.
 *
 * They also pin the three status codes apart, because the app renders something different for each:
 * `404` (webhooks off), `422` (not synced to the bridge yet), `400` (malformed request).
 *
 * No real network: the transport is an injected fake and the SSRF guard's DNS resolver is stubbed.
 */
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WebhookRepository } from '@/db/repositories/WebhookRepository.ts';
import type { CreateWebhookInput } from '@/db/repositories/types';
import { hydrateFromJson, type HydrateResult } from '../hydrate.ts';
import { mintTestToken } from '../fixtures/test-identity.ts';
import { createBridgeServer, type BridgeServerState, type WebhookTestCapability } from '../server.ts';
import { createWebhookDeliveryLog, type WebhookDeliveryLog } from './webhook-log.ts';
import { createWebhookTestFirer } from './webhook-test.ts';
import type { WebhookSecrets } from './webhook-targets.ts';
import type { FetchLike } from './webhook.ts';

const FIXTURE_URL = new URL('../fixtures/synthetic-snapshot.json', import.meta.url);
let TOKEN = '';
const PATH = '/api/v1/webhooks/test';
// A function, not a constant: the token is minted in `beforeAll`, so a value captured at module
// load would be the empty string.
const auth = () => ({ Authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' });

let hydrated: HydrateResult;
let state: BridgeServerState;

beforeAll(async () => {
  hydrated = await hydrateFromJson(await readFile(fileURLToPath(FIXTURE_URL), 'utf8'));
  // A caller is identified by a per-user token now, so the test mints one for the built-in
  // Admin (unrestricted, like the old shared token) against the hydrated fixture.
  TOKEN = await mintTestToken(hydrated.driver);
  state = { driver: hydrated.driver, snapshotGeneratedAt: null };
});

afterAll(async () => {
  await hydrated.driver.close();
});

/** Create a subscription in the hydrated snapshot, returning its id. */
async function createSubscription(overrides: Partial<CreateWebhookInput> = {}): Promise<string> {
  const created = await new WebhookRepository(hydrated.driver).create({
    name: 'Workshop notifier',
    url: 'https://hooks.example.test/inventory',
    method: 'POST',
    eventTypes: ['item.low_stock'],
    ...overrides,
  } as CreateWebhookInput);
  return created.id;
}

/** A fake transport that records what it was asked to send and answers with a fixed status. */
function fakeFetch(status = 204): { impl: FetchLike; calls: Array<{ url: string; body?: string }> } {
  const calls: Array<{ url: string; body?: string }> = [];
  return {
    calls,
    impl: (url, init) => {
      calls.push({ url, ...(init.body !== undefined ? { body: init.body } : {}) });
      return Promise.resolve({ ok: status >= 200 && status < 300, status });
    },
  };
}

interface ServerOptions {
  readonly enabled?: boolean;
  readonly secrets?: WebhookSecrets;
  readonly allowPrivate?: boolean;
  readonly fetchImpl?: FetchLike;
  readonly deliveryLog?: WebhookDeliveryLog;
}

async function startServer(options: ServerOptions = {}) {
  const deliveryLog = options.deliveryLog ?? createWebhookDeliveryLog();
  const webhookTest: WebhookTestCapability | undefined =
    options.enabled === false
      ? undefined
      : {
          secrets: options.secrets ?? {},
          deliver: createWebhookTestFirer({
            deliveryLog,
            ssrfPolicy: { allowPrivate: options.allowPrivate ?? false },
            // Every hostname resolves to a public address unless the URL is itself a literal, so
            // the guard's own classification is what these tests exercise — never real DNS.
            hostResolver: () => Promise.resolve(['203.0.113.10']),
            ...(options.fetchImpl !== undefined ? { fetchImpl: options.fetchImpl } : {}),
            log: () => {}, // keep the suite's output clean; the assertions read the log row
          }),
        };

  const server = createBridgeServer({
    getState: () => state,
    webhookDeliveries: deliveryLog,
    ...(webhookTest !== undefined ? { webhookTest } : {}),
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    deliveryLog,
    async fire(body: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
      const res = await fetch(`http://127.0.0.1:${port}${PATH}`, {
        method: 'POST',
        headers: auth(),
        body: typeof body === 'string' ? body : JSON.stringify(body),
      });
      return { status: res.status, json: (await res.json()) as Record<string, unknown> };
    },
    baseUrl: `http://127.0.0.1:${port}`,
    async stop() {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

describe('POST /api/v1/webhooks/test', () => {
  it('delivers a synthetic event and reports the log row it wrote', async () => {
    const id = await createSubscription({ name: 'Delivers', eventTypes: ['item.low_stock'] });
    const transport = fakeFetch(204);
    const { fire, deliveryLog, stop } = await startServer({ fetchImpl: transport.impl });
    try {
      const { status, json } = await fire({ subscriptionId: id });
      expect(status).toBe(200);
      expect(json.outcome).toBe('delivered');
      expect(json.status).toBe(204);
      expect(json.attempts).toBe(1);
      expect(json.seq).toBe(deliveryLog.latestSeq());

      // The row the app's `deliveries` poll will see is a real one, carrying the subscription's
      // own event type — and a redacted URL, never the raw one.
      const [row] = deliveryLog.list();
      expect(row?.targetId).toBe(id);
      expect(row?.eventType).toBe('item.low_stock');
      expect(row?.outcome).toBe('delivered');
      expect(row?.url).toBe('https://hooks.example.test/inventory');

      // It really went out, and it is marked as a test in the body a receiver sees.
      expect(transport.calls).toHaveLength(1);
      expect(transport.calls[0]!.body).toContain('test event');
    } finally {
      await stop();
    }
  });

  it('uses item.changed for a wildcard subscription', async () => {
    const id = await createSubscription({ name: 'Wildcard', eventTypes: ['*'] });
    const transport = fakeFetch(200);
    const { fire, deliveryLog, stop } = await startServer({ fetchImpl: transport.impl });
    try {
      expect((await fire({ subscriptionId: id })).json.outcome).toBe('delivered');
      expect(deliveryLog.list()[0]?.eventType).toBe('item.changed');
    } finally {
      await stop();
    }
  });

  it('reports `unmatched` — and writes no row — when the filter excludes the test event', async () => {
    // The matcher is not bypassed to force a send: a filter narrowing to an item legitimately
    // excludes an event that is about no real item, and saying so is the honest answer.
    const id = await createSubscription({
      name: 'Filtered',
      eventTypes: ['item.low_stock'],
      // A location filter narrows to a real item, and the test event is about none — so `W3`'s
      // documented "refuse to match what cannot be confirmed" rule excludes it.
      filter: { kind: 'location', locationIds: ['loc-workshop'] },
    });
    const transport = fakeFetch();
    const { fire, deliveryLog, stop } = await startServer({ fetchImpl: transport.impl });
    try {
      const { status, json } = await fire({ subscriptionId: id });
      expect(status).toBe(200);
      expect(json.outcome).toBe('unmatched');
      expect(json.seq).toBeNull();
      expect(json.attempts).toBe(0);
      expect(deliveryLog.latestSeq()).toBe(0); // nothing was logged
      expect(transport.calls).toHaveLength(0); // and nothing went on the wire
    } finally {
      await stop();
    }
  });

  it('reports `unmatched` for a disabled subscription', async () => {
    const id = await createSubscription({ name: 'Disabled', enabled: false });
    const { fire, stop } = await startServer({ fetchImpl: fakeFetch().impl });
    try {
      expect((await fire({ subscriptionId: id })).json.outcome).toBe('unmatched');
    } finally {
      await stop();
    }
  });

  it('reports `blocked` when the SSRF guard refuses a private destination', async () => {
    // The endpoint is a request-forgery primitive gated only by the bearer token, so the guard is
    // in the path exactly as it is for a real delivery — the reason comes back in `detail`.
    const id = await createSubscription({
      name: 'LAN receiver',
      url: 'http://192.168.1.10/hook',
    });
    const transport = fakeFetch();
    const { fire, deliveryLog, stop } = await startServer({
      fetchImpl: transport.impl,
      allowPrivate: false,
    });
    try {
      const { status, json } = await fire({ subscriptionId: id });
      expect(status).toBe(200);
      expect(json.outcome).toBe('blocked');
      expect(String(json.detail)).toMatch(/refused/i);
      expect(json.seq).toBe(deliveryLog.latestSeq()); // a blocked delivery is still logged
      expect(transport.calls).toHaveLength(0); // nothing was ever issued
    } finally {
      await stop();
    }
  });

  it('reports `blocked` for an unresolvable secret_ref rather than delivering it unsigned', async () => {
    const id = await createSubscription({ name: 'Signed', secretRef: 'missing-secret' });
    const transport = fakeFetch();
    const { fire, deliveryLog, stop } = await startServer({ fetchImpl: transport.impl, secrets: {} });
    try {
      const { json } = await fire({ subscriptionId: id });
      expect(json.outcome).toBe('blocked');
      expect(String(json.detail)).toContain('missing-secret');
      expect(transport.calls).toHaveLength(0);

      // This refusal happens before the deliverer is reached, so the endpoint logs the row itself
      // — otherwise it would be the one outcome missing from the log the app renders.
      expect(json.seq).toBe(deliveryLog.latestSeq());
      const [row] = deliveryLog.list();
      expect(row?.outcome).toBe('blocked');
      expect(row?.targetId).toBe(id);
      // The name of the missing ref is useful; its value must never exist here at all.
      expect(row?.detail).toContain('missing-secret');
    } finally {
      await stop();
    }
  });

  it('is a 404 when webhooks are not enabled — the feature is invisible, not failing', async () => {
    const { fire, stop } = await startServer({ enabled: false });
    try {
      const { status, json } = await fire({ subscriptionId: 'anything' });
      expect(status).toBe(404);
      expect((json.error as { code: string }).code).toBe('not_found');
    } finally {
      await stop();
    }
  });

  it('is a 422 for a subscription the bridge has not seen — distinct from the 404 above', async () => {
    // The app renders "changes reach the bridge on the next sync" for this, so it must never be
    // confusable with "webhooks are off".
    const { fire, stop } = await startServer();
    try {
      const { status, json } = await fire({ subscriptionId: 'not-in-this-snapshot' });
      expect(status).toBe(422);
      expect((json.error as { code: string }).code).toBe('unprocessable');
    } finally {
      await stop();
    }
  });

  it('is a 400 for a missing, non-string or unparseable subscriptionId', async () => {
    const { fire, stop } = await startServer();
    try {
      for (const body of [{}, { subscriptionId: 42 }, { subscriptionId: '  ' }, '{not json']) {
        const { status, json } = await fire(body);
        expect(status).toBe(400);
        expect((json.error as { code: string }).code).toBe('bad_request');
      }
    } finally {
      await stop();
    }
  });

  it('requires the bearer token', async () => {
    const { baseUrl, stop } = await startServer();
    try {
      const res = await fetch(`${baseUrl}${PATH}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ subscriptionId: 'anything' }),
      });
      expect(res.status).toBe(401);
    } finally {
      await stop();
    }
  });

  it('leaves the neighbouring /webhooks GET paths 404ing as before', async () => {
    const { baseUrl, stop } = await startServer();
    try {
      const headers = { Authorization: `Bearer ${TOKEN}` };
      expect((await fetch(`${baseUrl}/api/v1/webhooks`, { headers })).status).toBe(404);
      expect((await fetch(`${baseUrl}/api/v1/webhooks/subscriptions`, { headers })).status).toBe(404);
      // …and the test path itself is POST-only.
      expect((await fetch(`${baseUrl}${PATH}`, { headers })).status).toBe(404);
    } finally {
      await stop();
    }
  });
});
