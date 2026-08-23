/**
 * End-to-end tests for `GET /api/v1/webhooks/deliveries` (webhooks plan `W5`, §3.1), driving the
 * real bridge HTTP server in-process.
 *
 * The endpoint exists because the bridge **cannot** write delivery outcomes back into the database
 * — the snapshot is swapped wholesale on every hydration, so anything written is discarded. It is
 * therefore the app's only window onto what its subscriptions did, and what these tests pin is the
 * contract the app's poller depends on: bearer-gated, `404` when the capability is off, newest
 * first, and a `since`/`latestSeq` cursor that always advances.
 */
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hydrateFromJson, type HydrateResult } from '../hydrate.ts';
import { mintTestToken } from '../fixtures/test-identity.ts';
import { createBridgeServer, type BridgeServerState } from '../server.ts';
import {
  createWebhookDeliveryLog,
  type WebhookDeliveryInput,
  type WebhookDeliveryLog,
} from './webhook-log.ts';

const FIXTURE_URL = new URL('../fixtures/synthetic-snapshot.json', import.meta.url);
let TOKEN = '';
const PATH = '/api/v1/webhooks/deliveries';

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

function delivery(overrides: Partial<WebhookDeliveryInput> = {}): WebhookDeliveryInput {
  return {
    targetId: 'w1',
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

async function startServer(webhookDeliveries?: WebhookDeliveryLog) {
  const server = createBridgeServer({ getState: () => state, webhookDeliveries });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    async stop() {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

// A function, not a constant: the token is minted in `beforeAll`, so a value captured at module
// load would be the empty string.
const auth = () => ({ Authorization: `Bearer ${TOKEN}` });

describe('GET /api/v1/webhooks/deliveries', () => {
  it('is a 404 when webhooks are not enabled — the feature is invisible, not empty', async () => {
    // "The feature isn't on" and "nothing has been delivered yet" are different answers and must
    // not look alike, so this is a 404 rather than a 200 with an empty list.
    const { baseUrl, stop } = await startServer();
    try {
      const res = await fetch(`${baseUrl}${PATH}`, { headers: auth() });
      expect(res.status).toBe(404);
    } finally {
      await stop();
    }
  });

  it('requires the bearer token', async () => {
    const { baseUrl, stop } = await startServer(createWebhookDeliveryLog());
    try {
      expect((await fetch(`${baseUrl}${PATH}`)).status).toBe(401);
      expect((await fetch(`${baseUrl}${PATH}`, { headers: { Authorization: 'Bearer wrong' } })).status).toBe(
        401,
      );
    } finally {
      await stop();
    }
  });

  it('returns an empty page and a zero cursor before anything has been delivered', async () => {
    const { baseUrl, stop } = await startServer(createWebhookDeliveryLog());
    try {
      const res = await fetch(`${baseUrl}${PATH}`, { headers: auth() });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        deliveries: [],
        latestSeq: 0,
        logId: expect.any(String) as unknown as string,
      });
    } finally {
      await stop();
    }
  });

  it('returns recorded deliveries newest first, with the cursor', async () => {
    const log = createWebhookDeliveryLog();
    log.record(delivery({ eventId: 'hist-0001' }));
    log.record(delivery({ eventId: 'hist-0002', outcome: 'failed', status: 500 }));

    const { baseUrl, stop } = await startServer(log);
    try {
      const body = (await (await fetch(`${baseUrl}${PATH}`, { headers: auth() })).json()) as {
        deliveries: Array<{ eventId: string; outcome: string; seq: number }>;
        latestSeq: number;
      };
      expect(body.deliveries.map((d) => d.eventId)).toEqual(['hist-0002', 'hist-0001']);
      expect(body.deliveries[0]!.outcome).toBe('failed');
      expect(body.latestSeq).toBe(2);
    } finally {
      await stop();
    }
  });

  it('honours `since` — the polling form the app uses while its screen is open', async () => {
    const log = createWebhookDeliveryLog();
    log.record(delivery({ eventId: 'hist-0001' }));
    const { baseUrl, stop } = await startServer(log);
    try {
      const first = (await (await fetch(`${baseUrl}${PATH}`, { headers: auth() })).json()) as {
        latestSeq: number;
      };

      // Nothing new: an empty page, but the cursor still comes back so the poller can advance.
      const quiet = (await (
        await fetch(`${baseUrl}${PATH}?since=${first.latestSeq}`, { headers: auth() })
      ).json()) as { deliveries: unknown[]; latestSeq: number };
      expect(quiet.deliveries).toEqual([]);
      expect(quiet.latestSeq).toBe(first.latestSeq);

      log.record(delivery({ eventId: 'hist-0002' }));
      const next = (await (
        await fetch(`${baseUrl}${PATH}?since=${first.latestSeq}`, { headers: auth() })
      ).json()) as { deliveries: Array<{ eventId: string }> };
      expect(next.deliveries.map((d) => d.eventId)).toEqual(['hist-0002']);
    } finally {
      await stop();
    }
  });

  /**
   * Issue #645: `seq` restarts at zero with the bridge, so a poller cannot tell a quiet minute from
   * a restarted log by the numbers alone. `logId` is what makes it decidable.
   */
  it('identifies the log instance, so a poller can see that it restarted', async () => {
    const log = createWebhookDeliveryLog();
    const { baseUrl, stop } = await startServer(log);
    try {
      const first = (await (await fetch(`${baseUrl}${PATH}`, { headers: auth() })).json()) as {
        logId: string;
      };
      // `expect.any(String)`, not `not.toBe('')`: the response is cast rather than parsed, so an
      // absent field would arrive as `undefined` and slip past a comparison with the empty string.
      expect(first.logId).toEqual(expect.any(String));
      expect(first.logId).not.toBe('');

      // Same log, same id — a second read must not look like a restart.
      log.record(delivery({ eventId: 'hist-0001' }));
      const second = (await (await fetch(`${baseUrl}${PATH}`, { headers: auth() })).json()) as {
        logId: string;
      };
      expect(second.logId).toBe(first.logId);
    } finally {
      await stop();
    }
  });

  it('honours and clamps `limit`', async () => {
    const log = createWebhookDeliveryLog({ size: 500 });
    for (let i = 0; i < 250; i++) log.record(delivery({ eventId: `hist-${i}` }));
    const { baseUrl, stop } = await startServer(log);
    try {
      const page = (await (await fetch(`${baseUrl}${PATH}?limit=2`, { headers: auth() })).json()) as {
        deliveries: unknown[];
      };
      expect(page.deliveries).toHaveLength(2);

      const clamped = (await (await fetch(`${baseUrl}${PATH}?limit=9999`, { headers: auth() })).json()) as {
        deliveries: unknown[];
      };
      expect(clamped.deliveries).toHaveLength(200);
    } finally {
      await stop();
    }
  });

  it('rejects a malformed `since` or `limit` with a 400', async () => {
    const { baseUrl, stop } = await startServer(createWebhookDeliveryLog());
    try {
      for (const query of ['?since=abc', '?since=-1', '?limit=0', '?limit=nope']) {
        const res = await fetch(`${baseUrl}${PATH}${query}`, { headers: auth() });
        expect(res.status).toBe(400);
        expect(((await res.json()) as { error: { code: string } }).error.code).toBe('bad_request');
      }
    } finally {
      await stop();
    }
  });

  it('404s an unknown path below /webhooks rather than falling through', async () => {
    const { baseUrl, stop } = await startServer(createWebhookDeliveryLog());
    try {
      expect((await fetch(`${baseUrl}/api/v1/webhooks`, { headers: auth() })).status).toBe(404);
      expect((await fetch(`${baseUrl}/api/v1/webhooks/subscriptions`, { headers: auth() })).status).toBe(404);
    } finally {
      await stop();
    }
  });
});
