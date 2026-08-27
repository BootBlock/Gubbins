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
import { mintTestToken } from './fixtures/test-identity.ts';
import { createBridgeServer, type BridgeServerState, type WriteCapability } from './server.ts';
import { WriteError, type WriteOperation } from './write.ts';
import type { CheckoutDto, ItemDetailDto } from './api/dto.ts';

const FIXTURE_URL = new URL('./fixtures/synthetic-snapshot.json', import.meta.url);
let TOKEN = '';

let hydrated: HydrateResult;
let state: BridgeServerState;

/** The operations the mock executor received, in order (asserted by the routing tests). */
const calls: WriteOperation[] = [];

/** The `Idempotency-Key` each call arrived with, in the same order as {@link calls}. */
const keys: (string | undefined)[] = [];

/**
 * Keys the mock has already seen, so it can report a replay exactly as the real executor does —
 * the transport contract under test here is "the header reaches the executor and its verdict
 * reaches the response", not the store itself (that is `idempotency.test.ts`).
 */
const seenKeys = new Set<string>();

const stubDetail = { id: 'item-m3-bolt', name: 'M3 x 10 Hex Bolt', quantity: 41 } as unknown as ItemDetailDto;
const stubCheckout = { id: 'loan-1', itemId: 'item-m3-bolt', status: 'OPEN' } as unknown as CheckoutDto;

const writeCapability: WriteCapability = {
  execute: async (op, _actorUserId, idempotencyKey) => {
    calls.push(op);
    keys.push(idempotencyKey);
    if (op.itemId === 'unknown-item') throw new WriteError(404, 'not_found', 'No such item.');
    if (op.kind === 'adjust-quantity' && op.delta < -1000) {
      throw new WriteError(422, 'unprocessable', 'Quantity cannot fall below zero.');
    }
    const replayed = idempotencyKey !== undefined && seenKeys.has(idempotencyKey);
    if (idempotencyKey !== undefined) seenKeys.add(idempotencyKey);
    const isLoan = op.kind === 'check-out' || op.kind === 'check-in';
    return { result: { item: stubDetail, checkout: isLoan ? stubCheckout : null }, replayed };
  },
};

let writableServer: ReturnType<typeof createBridgeServer>;
let readonlyServer: ReturnType<typeof createBridgeServer>;
let writableBase: string;
let readonlyBase: string;

beforeAll(async () => {
  hydrated = await hydrateFromJson(await readFile(fileURLToPath(FIXTURE_URL), 'utf8'));
  // A caller is identified by a per-user token now, so the test mints one for the built-in
  // Admin (unrestricted, like the old shared token) against the hydrated fixture.
  TOKEN = await mintTestToken(hydrated.driver);
  state = {
    driver: hydrated.driver,
    snapshotGeneratedAt: new Date(hydrated.snapshot.generatedAt).toISOString(),
  };

  writableServer = createBridgeServer({ getState: () => state, write: writeCapability });
  readonlyServer = createBridgeServer({ getState: () => state }); // no write capability
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
  // `...init` is spread first so the merged headers below always win — spreading it last would
  // replace them wholesale, silently dropping the bearer token and turning every override into
  // a confusing 401.
  return fetch(`${base}${path}`, {
    body: body === undefined ? undefined : JSON.stringify(body),
    ...init,
    method: 'POST',
    headers: {
      authorization: `Bearer ${TOKEN}`,
      'content-type': 'application/json',
      ...(init.headers ?? {}),
    },
  });
}

describe('writes disabled (default)', () => {
  it('returns 404 for a POST to a write path — the endpoint is invisible', async () => {
    const res = await post(readonlyBase, '/api/v1/items/item-m3-bolt/adjust-quantity', { delta: -1 });
    expect(res.status).toBe(404);
    expect((await res.json()).error.code).toBe('not_found');
  });

  it('still rejects a POST with a missing token before anything else (401)', async () => {
    // Drives fetch directly rather than through `post`, which always attaches the bearer token —
    // the point here is the *absence* of one, so it must not be supplied at all.
    const res = await fetch(`${readonlyBase}/api/v1/items/item-m3-bolt/adjust-quantity`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ delta: -1 }),
    });
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

  const postAs = (contentType: string, body: string): Promise<Response> =>
    post(writableBase, '/api/v1/items/item-m3-bolt/adjust-quantity', undefined, {
      headers: { 'content-type': contentType },
      body,
    });

  it('rejects a non-JSON Content-Type with 415 rather than parsing the body anyway', async () => {
    const res = await postAs('application/x-www-form-urlencoded', 'delta=-2');
    expect(res.status).toBe(415);
    expect((await res.json()).error.code).toBe('unsupported_media_type');
  });

  it('accepts a JSON Content-Type with parameters, and the +json structured suffix', async () => {
    for (const contentType of ['application/json; charset=utf-8', 'application/merge-patch+json']) {
      const res = await postAs(contentType, JSON.stringify({ delta: 1 }));
      expect(res.status).toBe(200);
    }
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
    const body = await res.json();
    expect(body.writable).toBe(true);
    expect(body.endpoints).toContain('POST /api/v1/items/{id}/check-out');
    expect(body.endpoints).toContain('POST /api/v1/items/{id}/check-in');
    expect(body.endpoints).toContain('POST /api/v1/items/{id}/transfer-stock');
  });
});

// --- loans and stock movement (issue #142) ----------------------------------------

describe('loan and transfer endpoints', () => {
  it('forwards a check-out and answers with the item AND the loan', async () => {
    calls.length = 0;
    const res = await post(writableBase, '/api/v1/items/item-m3-bolt/check-out', {
      contactName: 'Sam Okafor',
      quantity: 2,
      dueDate: '2026-08-14',
      note: 'For the bench build',
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    // The loan's id is the point of the wrapped shape: it is what a later check-in names.
    expect(body.item.id).toBe('item-m3-bolt');
    expect(body.checkout.id).toBe('loan-1');
    expect(calls).toEqual([
      {
        kind: 'check-out',
        itemId: 'item-m3-bolt',
        contactName: 'Sam Okafor',
        quantity: 2,
        dueDate: '2026-08-14',
        note: 'For the bench build',
      },
    ]);
  });

  it('omits absent borrower fields rather than forwarding them as undefined', async () => {
    calls.length = 0;
    await post(writableBase, '/api/v1/items/item-m3-bolt/check-out', { projectId: 'proj-1' });
    expect(calls).toEqual([{ kind: 'check-out', itemId: 'item-m3-bolt', projectId: 'proj-1' }]);
  });

  it('carries an explicit null dueDate through as an open-ended loan', async () => {
    calls.length = 0;
    await post(writableBase, '/api/v1/items/item-m3-bolt/check-out', {
      contactId: 'contact-1',
      dueDate: null,
    });
    expect(calls).toEqual([
      { kind: 'check-out', itemId: 'item-m3-bolt', contactId: 'contact-1', dueDate: null },
    ]);
  });

  it('rejects a non-string dueDate with 400', async () => {
    const res = await post(writableBase, '/api/v1/items/item-m3-bolt/check-out', {
      contactId: 'contact-1',
      dueDate: 1_760_000_000_000,
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe('bad_request');
  });

  it('forwards a check-in with no body fields (the single-open-loan case)', async () => {
    calls.length = 0;
    const res = await post(writableBase, '/api/v1/items/item-m3-bolt/check-in', {});
    expect(res.status).toBe(200);
    expect((await res.json()).checkout.id).toBe('loan-1');
    expect(calls).toEqual([{ kind: 'check-in', itemId: 'item-m3-bolt' }]);
  });

  it('forwards a check-in naming a specific loan', async () => {
    calls.length = 0;
    await post(writableBase, '/api/v1/items/item-m3-bolt/check-in', {
      checkoutId: 'loan-9',
      note: 'Chipped blade',
    });
    expect(calls).toEqual([
      { kind: 'check-in', itemId: 'item-m3-bolt', checkoutId: 'loan-9', note: 'Chipped blade' },
    ]);
  });

  it('forwards a transfer and answers with the bare item (no loan involved)', async () => {
    calls.length = 0;
    const res = await post(writableBase, '/api/v1/items/item-m3-bolt/transfer-stock', {
      fromLocationId: 'loc-a',
      toLocationId: 'loc-b',
      quantity: 5,
    });
    expect(res.status).toBe(200);
    expect((await res.json()).id).toBe('item-m3-bolt'); // the item itself, exactly like adjust-*
    expect(calls).toEqual([
      {
        kind: 'transfer-stock',
        itemId: 'item-m3-bolt',
        fromLocationId: 'loc-a',
        toLocationId: 'loc-b',
        quantity: 5,
      },
    ]);
  });

  it('rejects a transfer missing a destination with 400', async () => {
    const res = await post(writableBase, '/api/v1/items/item-m3-bolt/transfer-stock', {
      fromLocationId: 'loc-a',
      quantity: 5,
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error.message).toMatch(/toLocationId/);
  });

  it('404s a loan path when writes are off, exactly like the adjust paths', async () => {
    const res = await post(readonlyBase, '/api/v1/items/item-m3-bolt/check-out', { contactName: 'Sam' });
    expect(res.status).toBe(404);
  });
});

// --- the Idempotency-Key transport contract (issue #567) ---------------------------

describe('the Idempotency-Key header', () => {
  /** Post an adjust-quantity carrying `key`, so each test names its own attempt. */
  function adjust(key: string | undefined, delta = -1): Promise<Response> {
    return post(
      writableBase,
      '/api/v1/items/item-m3-bolt/adjust-quantity',
      { delta },
      key === undefined ? {} : { headers: { 'idempotency-key': key } },
    );
  }

  it('forwards the key to the executor and reports a fresh write', async () => {
    keys.length = 0;
    const res = await adjust('key-fresh');
    expect(res.status).toBe(200);
    expect(keys).toEqual(['key-fresh']);
    expect(res.headers.get('idempotency-replayed')).toBe('false');
  });

  it('reports a replay when the same key comes back', async () => {
    await adjust('key-repeat');
    const res = await adjust('key-repeat');
    expect(res.status).toBe(200);
    expect(res.headers.get('idempotency-replayed')).toBe('true');
  });

  it('omits the header entirely when the caller sent no key', async () => {
    keys.length = 0;
    const res = await adjust(undefined);
    expect(res.status).toBe(200);
    expect(keys).toEqual([undefined]);
    // A constant `false` would say nothing to a caller that never asked for the guarantee.
    expect(res.headers.get('idempotency-replayed')).toBeNull();
  });

  it('exposes the outcome header to a browser caller', async () => {
    const res = await adjust('key-cors');
    expect(res.headers.get('access-control-expose-headers')).toMatch(/Idempotency-Replayed/);
  });

  it('rejects a malformed key with 400 rather than silently ignoring it', async () => {
    keys.length = 0;
    const res = await adjust('not a key');
    expect(res.status).toBe(400);
    expect((await res.json()).error.message).toMatch(/Idempotency-Key/);
    expect(keys).toEqual([]); // refused before the write, so nothing was applied
  });

  it('rejects an over-long key', async () => {
    const res = await adjust('k'.repeat(201));
    expect(res.status).toBe(400);
  });

  it('lists the header on the CORS preflight, so a browser does not strip it', async () => {
    const res = await fetch(`${writableBase}/api/v1/items/item-m3-bolt/adjust-quantity`, {
      method: 'OPTIONS',
    });
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-headers')).toMatch(/Idempotency-Key/);
  });
});
