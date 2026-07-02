/**
 * HTTP snapshot-ingest tests over the SYNTHETIC fixture (no real or personal data).
 *
 * These exercise the server's routing, the opt-in gate, auth ordering, and the {@link PushError}
 * → HTTP mapping for `POST /api/v1/snapshot`. The streaming temp-file → validate → rename core is
 * tested in `push.test.ts`; here a mock `push.ingest` records what it received so we assert the
 * transport contract in isolation. Two servers are bound: one with push enabled, one without (to
 * prove the endpoint is invisible — a 404 — when off).
 */
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hydrateFromJson, type HydrateResult } from './hydrate.ts';
import { createBridgeServer, type BridgeServerState, type PushCapability } from './server.ts';
import { PushError } from './push.ts';

const FIXTURE_URL = new URL('./fixtures/synthetic-snapshot.json', import.meta.url);
const TOKEN = 'placeholder-token-for-tests';

let hydrated: HydrateResult;
let state: BridgeServerState;

/** The bodies the mock ingest received, decoded to text (asserted by the routing tests). */
const ingested: string[] = [];

const pushCapability: PushCapability = {
  ingest: async (body) => {
    const chunks: Buffer[] = [];
    for await (const chunk of body) chunks.push(Buffer.from(chunk));
    const text = Buffer.concat(chunks).toString('utf8');
    ingested.push(text);
    if (text.includes('"formatVersion":9999')) {
      throw new PushError(422, 'unprocessable', 'This backup was made by a newer version of Gubbins.');
    }
    if (text === 'TOO BIG') {
      throw new PushError(413, 'payload_too_large', 'The snapshot exceeds the maximum push size.');
    }
    return { formatVersion: 1, generatedAt: 1751000000000 };
  },
};

let pushableServer: ReturnType<typeof createBridgeServer>;
let readonlyServer: ReturnType<typeof createBridgeServer>;
let pushableBase: string;
let readonlyBase: string;

beforeAll(async () => {
  hydrated = await hydrateFromJson(await readFile(fileURLToPath(FIXTURE_URL), 'utf8'));
  state = { driver: hydrated.driver, snapshotGeneratedAt: null };

  pushableServer = createBridgeServer({ token: TOKEN, getState: () => state, push: pushCapability });
  readonlyServer = createBridgeServer({ token: TOKEN, getState: () => state }); // no push capability
  await new Promise<void>((r) => pushableServer.listen(0, '127.0.0.1', r));
  await new Promise<void>((r) => readonlyServer.listen(0, '127.0.0.1', r));
  pushableBase = `http://127.0.0.1:${(pushableServer.address() as AddressInfo).port}`;
  readonlyBase = `http://127.0.0.1:${(readonlyServer.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((r) => pushableServer.close(() => r()));
  await new Promise<void>((r) => readonlyServer.close(() => r()));
  await hydrated.driver.close();
});

function post(base: string, body: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`${base}/api/v1/snapshot`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${TOKEN}`,
      'content-type': 'application/json',
      ...(init.headers ?? {}),
    },
    body,
    ...init,
  });
}

describe('push disabled (default)', () => {
  it('returns 404 for a POST to /api/v1/snapshot — the endpoint is invisible', async () => {
    const res = await post(readonlyBase, '{"formatVersion":1}');
    expect(res.status).toBe(404);
    expect((await res.json()).error.code).toBe('not_found');
  });

  it('rejects a push with a missing token before anything else (401)', async () => {
    const res = await post(readonlyBase, '{"formatVersion":1}', {
      headers: { 'content-type': 'application/json' },
    });
    expect(res.status).toBe(401);
  });

  it('advertises pushable:false in the API index', async () => {
    const res = await fetch(`${readonlyBase}/api/v1`, { headers: { authorization: `Bearer ${TOKEN}` } });
    expect((await res.json()).pushable).toBe(false);
  });
});

describe('push enabled', () => {
  it('forwards a valid snapshot body and returns its summary', async () => {
    ingested.length = 0;
    const res = await post(pushableBase, '{"formatVersion":1,"generatedAt":1751000000000,"tables":{}}');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ ok: true, formatVersion: 1, generatedAt: 1751000000000 });
    expect(ingested).toHaveLength(1);
  });

  it('maps a PushError(422) from a newer-version snapshot to a 422 unprocessable', async () => {
    const res = await post(pushableBase, '{"formatVersion":9999}');
    expect(res.status).toBe(422);
    expect((await res.json()).error.code).toBe('unprocessable');
  });

  it('maps a PushError(413) from an over-large body to a 413 payload_too_large', async () => {
    const res = await post(pushableBase, 'TOO BIG');
    expect(res.status).toBe(413);
    expect((await res.json()).error.code).toBe('payload_too_large');
  });

  it('404s a GET to /api/v1/snapshot (ingest is POST-only)', async () => {
    const res = await fetch(`${pushableBase}/api/v1/snapshot`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(404);
  });

  it('advertises pushable:true in the API index', async () => {
    const res = await fetch(`${pushableBase}/api/v1`, { headers: { authorization: `Bearer ${TOKEN}` } });
    expect((await res.json()).pushable).toBe(true);
  });
});
