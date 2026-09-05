/**
 * End-to-end SSE tests (EI-1) driving the real bridge HTTP server in-process over a synthetic
 * fixture. Asserts the stream is bearer-gated, streams delivered events live, and is a 404 when
 * the events capability is not wired (the flag-off posture).
 */
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hydrateFromJson, type HydrateResult } from '../hydrate.ts';
import { mintTestToken } from '../fixtures/test-identity.ts';
import { createBridgeServer, type BridgeServerState } from '../server.ts';
import { createSseHub } from './sse.ts';

const FIXTURE_URL = new URL('../fixtures/synthetic-snapshot.json', import.meta.url);
let TOKEN = '';

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

/** Start a server (optionally with the SSE hub) on an ephemeral port; returns base URL + teardown. */
async function startServer(hub?: ReturnType<typeof createSseHub>) {
  const server = createBridgeServer({ getState: () => state, events: hub });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    async stop() {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

describe('GET /api/v1/events', () => {
  it('streams a delivered event to a subscribed client', async () => {
    const hub = createSseHub({ heartbeatMs: 0 });
    const { baseUrl, stop } = await startServer(hub);
    const ac = new AbortController();
    try {
      const res = await fetch(`${baseUrl}/api/v1/events`, {
        headers: { authorization: `Bearer ${TOKEN}` },
        signal: ac.signal,
      });
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toContain('text/event-stream');

      // The client is registered by the time the response headers arrive; deliver now.
      hub.deliver([
        {
          id: 'evt-1',
          type: 'item.low_stock',
          occurredAt: '2025-06-27T06:13:20.000Z',
          data: {
            itemId: 'item-esp32',
            itemName: 'ESP32 Dev Board',
            action: 'QUANTITY_CHANGE',
            kind: 'stock',
            label: 'Quantity changed',
            detail: null,
            delta: '−4',
            quantityDelta: -4,
            netValueDelta: null,
            actorUserId: 'user-ada',
            actorDisplayName: 'Ada',
            item: null,
          },
        },
      ]);

      const text = await readUntil(res, 'evt-1');
      expect(text).toContain('id: evt-1');
      expect(text).toContain('"type":"item.low_stock"');
    } finally {
      ac.abort();
      await stop();
    }
  });

  it('is a 404 when the events capability is not enabled (flag off)', async () => {
    const { baseUrl, stop } = await startServer(); // no hub
    try {
      const res = await fetch(`${baseUrl}/api/v1/events`, { headers: { authorization: `Bearer ${TOKEN}` } });
      expect(res.status).toBe(404);
      await res.body?.cancel();
    } finally {
      await stop();
    }
  });

  it('requires the bearer token', async () => {
    const hub = createSseHub({ heartbeatMs: 0 });
    const { baseUrl, stop } = await startServer(hub);
    try {
      const res = await fetch(`${baseUrl}/api/v1/events`);
      expect(res.status).toBe(401);
      await res.body?.cancel();
    } finally {
      await stop();
    }
  });

  it('advertises streamable:true in the API index when enabled', async () => {
    const hub = createSseHub({ heartbeatMs: 0 });
    const { baseUrl, stop } = await startServer(hub);
    try {
      const res = await fetch(`${baseUrl}/api/v1`, { headers: { authorization: `Bearer ${TOKEN}` } });
      const body = await res.json();
      expect(body.streamable).toBe(true);
      expect(body.endpoints).toContain('/api/v1/events');
    } finally {
      await stop();
    }
  });
});

/** Read the SSE response body until `needle` appears (or a bounded number of chunks elapse). */
async function readUntil(res: Response, needle: string): Promise<string> {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let text = '';
  for (let i = 0; i < 50; i++) {
    const { value, done } = await reader.read();
    if (value) text += decoder.decode(value, { stream: true });
    if (text.includes(needle) || done) break;
  }
  return text;
}
