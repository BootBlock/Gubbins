/**
 * HTTP write-endpoint tests over the SYNTHETIC fixture (no real or personal data).
 *
 * These exercise the server's routing, the opt-in gate, body validation, and the
 * {@link WriteError} → HTTP mapping for the POST adjust endpoints. The mutation core and the
 * no-drift sync round-trip are tested in `write.test.ts`; here a mock `write.execute` records the
 * forwarded operation so we assert the transport contract in isolation. Two servers are bound: one
 * with writes enabled, one without (to prove writes are invisible — a 404 — when off).
 */
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hydrateFromJson, type HydrateResult } from './hydrate.ts';
import { createBridgeServer, type BridgeServerState, type WriteCapability } from './server.ts';
import { WriteError, type WriteOperation } from './write.ts';
import type { ItemDetailDto } from './api/dto.ts';

const FIXTURE_URL = new URL('./fixtures/synthetic-snapshot.json', import.meta.url);
const TOKEN = 'placeholder-token-for-tests';

let hydrated: HydrateResult;
let state: BridgeServerState;

/** The operations the mock executor received, in order (asserted by the routing tests). */
const calls: WriteOperation[] = [];

const stubDetail = { id: 'item-m3-bolt', name: 'M3 x 10 Hex Bolt', quantity: 41 } as unknown as ItemDetailDto;

const writeCapability: WriteCapability = {
  execute: async (op) => {
    calls.push(op);
    if (op.itemId === 'unknown-item') throw new WriteError(404, 'not_found', 'No such item.');
    if (op.kind === 'adjust-quantity' && op.delta < -1000) {
      throw new WriteError(422, 'unprocessable', 'Quantity cannot fall below zero.');
    }
    return stubDetail;
  },
};

let writableServer: ReturnType<typeof createBridgeServer>;
let readonlyServer: ReturnType<typeof createBridgeServer>;
let writableBase: string;
let readonlyBase: string;

beforeAll(async () => {
  hydrated = await hydrateFromJson(await readFile(fileURLToPath(FIXTURE_URL), 'utf8'));
  state = {
    driver: hydrated.driver,
    snapshotGeneratedAt: new Date(hydrated.snapshot.generatedAt).toISOString(),
  };

  writableServer = createBridgeServer({ token: TOKEN, getState: () => state, write: writeCapability });
  readonlyServer = createBridgeServer({ token: TOKEN, getState: () => state }); // no write capability
  await new Promise<void>((r) => writableServer.listen(0, '127.0.0.1', r));
  await new Promise<void>((r) => readonlyServer.listen(0, '127.0.0.1', r));
  writableBase = `http://127.0.0.1:${(writableServer.address() as AddressInfo).port}`;
  readonlyBase = `http://127.0.0.1:${(readonlyServer.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((r) => writableServer.close(() => r()));
  await new Promise<void>((r) => readonlyServer.close(() => r()));
  await hydrated.driver.close();
});

function post(base: string, path: string, body?: unknown, init: RequestInit = {}): Promise<Response> {
  return fetch(`${base}${path}`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${TOKEN}`,
      'content-type': 'application/json',
      ...(init.headers ?? {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    ...init,
  });
}

describe('writes disabled (default)', () => {
  it('returns 404 for a POST to a write path — the endpoint is invisible', async () => {
    const res = await post(readonlyBase, '/api/v1/items/item-m3-bolt/adjust-quantity', { delta: -1 });
    expect(res.status).toBe(404);
    expect((await res.json()).error.code).toBe('not_found');
  });

  it('still rejects a POST with a missing token before anything else (401)', async () => {
    const res = await post(
      readonlyBase,
      '/api/v1/items/item-m3-bolt/adjust-quantity',
      { delta: -1 },
      {
        headers: { 'content-type': 'application/json' },
      },
    );
    expect(res.status).toBe(401);
  });

  it('advertises writable:false in the API index', async () => {
    const res = await fetch(`${readonlyBase}/api/v1`, { headers: { authorization: `Bearer ${TOKEN}` } });
    expect((await res.json()).writable).toBe(false);
  });
});

describe('writes enabled', () => {
  it('forwards a valid adjust-quantity and returns the updated item', async () => {
    calls.length = 0;
    const res = await post(writableBase, '/api/v1/items/item-m3-bolt/adjust-quantity', {
      delta: -1,
      note: 'lent one',
    });
    expect(res.status).toBe(200);
    expect((await res.json()).id).toBe('item-m3-bolt');
    expect(calls).toEqual([{ kind: 'adjust-quantity', itemId: 'item-m3-bolt', delta: -1, note: 'lent one' }]);
  });

  it('forwards a valid adjust-gauge (note omitted)', async () => {
    calls.length = 0;
    const res = await post(writableBase, '/api/v1/items/item-spool/adjust-gauge', { delta: -45 });
    expect(res.status).toBe(200);
    expect(calls).toEqual([{ kind: 'adjust-gauge', itemId: 'item-spool', delta: -45 }]);
  });

  it('url-decodes the item id segment', async () => {
    calls.length = 0;
    await post(writableBase, '/api/v1/items/item%20a%2Fb/adjust-quantity', { delta: 1 });
    expect(calls[0]?.itemId).toBe('item a/b');
  });

  it('rejects a non-numeric delta with 400', async () => {
    const res = await post(writableBase, '/api/v1/items/item-m3-bolt/adjust-quantity', { delta: 'lots' });
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe('bad_request');
  });

  it('rejects a malformed JSON body with 400', async () => {
    const res = await post(writableBase, '/api/v1/items/item-m3-bolt/adjust-quantity', undefined, {
      body: '{ not json',
    });
    expect(res.status).toBe(400);
  });

  it('maps a WriteError(404) from the executor to a 404 not_found', async () => {
    const res = await post(writableBase, '/api/v1/items/unknown-item/adjust-quantity', { delta: 1 });
    expect(res.status).toBe(404);
    expect((await res.json()).error.code).toBe('not_found');
  });

  it('maps a domain rejection to a 422 unprocessable', async () => {
    const res = await post(writableBase, '/api/v1/items/item-m3-bolt/adjust-quantity', { delta: -99999 });
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.error.code).toBe('unprocessable');
    expect(body.error.message).toMatch(/below zero/i);
  });

  it('404s a POST to an unknown write action', async () => {
    expect((await post(writableBase, '/api/v1/items/item-m3-bolt/teleport', { delta: 1 })).status).toBe(404);
  });

  it('405s a POST to a legacy (non-v1) path', async () => {
    const res = await post(writableBase, '/search', { delta: 1 });
    expect(res.status).toBe(405);
  });

  it('404s a GET to a write path (reads don’t route there)', async () => {
    const res = await fetch(`${writableBase}/api/v1/items/item-m3-bolt/adjust-quantity`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(404);
  });

  it('advertises writable:true in the API index', async () => {
    const res = await fetch(`${writableBase}/api/v1`, { headers: { authorization: `Bearer ${TOKEN}` } });
    expect((await res.json()).writable).toBe(true);
  });
});
