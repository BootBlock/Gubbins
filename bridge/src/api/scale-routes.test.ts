/**
 * `/api/v1/scale/*` route tests (issue #122) — the opt-in Home Assistant read.
 *
 * Driven in-process against a real server bound to an ephemeral loopback port, with a **fake
 * `HaClient`** injected: no Home Assistant, no network. Two properties carry the weight:
 *
 * - **Off by default is invisible.** With no capability the paths are `404`, not `403` — the same
 *   posture the write and push opt-ins take.
 * - **An unusable reading is never a `200`.** The caller turns this number into a stock count, so
 *   "unavailable" or "unit I can't convert" must be a distinct failure rather than a zero.
 *
 * These routes read Home Assistant rather than the snapshot, so they once ran with no snapshot at
 * all. Since issue #79 they still need one: a caller is identified by a per-user token that lives
 * in the database, so *authentication* needs the snapshot even where the answer does not. A
 * hydrated fixture is therefore wired in, and a bridge with no snapshot now refuses every route.
 */
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createBridgeServer, type BridgeServerState, type ScaleCapability } from '../server.ts';
import { hydrateFromJson, type HydrateResult } from '../hydrate.ts';
import { mintTestToken } from '../fixtures/test-identity.ts';
import { HaError } from '../homeassistant/client.ts';
import { createScaleStreamHub, type ScaleStreamHub } from '../homeassistant/scale-stream.ts';
import type { ScaleEntityDto, ScaleReadingOutcome } from '../homeassistant/scale.ts';

const FIXTURE_URL = new URL('../fixtures/synthetic-snapshot.json', import.meta.url);

let TOKEN = '';
let hydrated: HydrateResult;
let state: BridgeServerState;
let server: ReturnType<typeof createBridgeServer> | undefined;

beforeAll(async () => {
  hydrated = await hydrateFromJson(await readFile(fileURLToPath(FIXTURE_URL), 'utf8'));
  state = {
    driver: hydrated.driver,
    snapshotGeneratedAt: new Date(hydrated.snapshot.generatedAt).toISOString(),
  };
  TOKEN = await mintTestToken(hydrated.driver);
});

afterAll(async () => {
  await hydrated.driver.close();
});

/** Every stream hub a case built, closed in teardown so no poll loop outlives it. */
let hubs: ScaleStreamHub[] = [];

afterEach(async () => {
  for (const hub of hubs) hub.close();
  hubs = [];
  if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
  server = undefined;
});

/**
 * Start a server with the given scale capability (omit for "the operator never opted in") and
 * return a bound GET helper. The state is the hydrated fixture — needed to resolve the caller's
 * token, not to answer the scale reads themselves, which still never touch it.
 */
async function start(scale?: ScaleCapability) {
  server = createBridgeServer({ getState: () => state, scale });
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return (path: string) =>
    fetch(`http://127.0.0.1:${port}${path}`, { headers: { authorization: `Bearer ${TOKEN}` } });
}

/** A fake HA client returning canned results. */
function fakeScale(overrides: {
  entities?: ScaleEntityDto[];
  reading?: ScaleReadingOutcome;
  throws?: unknown;
}): ScaleCapability & { readonly stream: ScaleStreamHub } {
  const client = {
    listScaleEntities: async () => {
      if (overrides.throws) throw overrides.throws;
      return overrides.entities ?? [];
    },
    readScale: async () => {
      if (overrides.throws) throw overrides.throws;
      return overrides.reading ?? ({ ok: false, issue: 'unavailable' } as ScaleReadingOutcome);
    },
  };
  // The real hub, over the fake client: the point of these cases is the *server* wiring — the
  // capability gate, the auth guard and the long-lived response — and the hub's own behaviour is
  // covered in `homeassistant/scale-stream.test.ts`. Registered for teardown so no poll loop
  // outlives its case.
  const stream = createScaleStreamHub({ readScale: client.readScale, heartbeatMs: 0, pollMs: 5 });
  hubs.push(stream);
  return { client, stream };
}

const READING: ScaleReadingOutcome = {
  ok: true,
  reading: {
    entityId: 'sensor.bench_scale',
    grams: 1250,
    value: 1.25,
    unit: 'kg',
    lastUpdated: '2026-07-18T10:00:00.000Z',
  },
};

describe('when Home Assistant reads are not opted in', () => {
  it('answers 404 for every scale path, so the feature is invisible', async () => {
    const get = await start();
    expect((await get('/api/v1/scale/entities')).status).toBe(404);
    expect((await get('/api/v1/scale/state?entity_id=sensor.bench_scale')).status).toBe(404);
    const stream = await get('/api/v1/scale/stream?entity_id=sensor.bench_scale');
    expect(stream.status).toBe(404);
    await stream.json();
  });

  it('does not advertise the capability in the discovery index', async () => {
    const get = await start();
    const body = await (await get('/api/v1')).json();
    expect(body.scalable).toBe(false);
    expect(body.endpoints).not.toContain('/api/v1/scale/entities');
  });
});

describe('GET /api/v1/scale/entities', () => {
  it('returns the pickable weight sensors', async () => {
    const get = await start(
      fakeScale({ entities: [{ entityId: 'sensor.bench_scale', name: 'Bench scale', unit: 'kg' }] }),
    );
    const res = await get('/api/v1/scale/entities');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      entities: [{ entityId: 'sensor.bench_scale', name: 'Bench scale', unit: 'kg' }],
    });
  });

  it('advertises the capability in the discovery index when enabled', async () => {
    const get = await start(fakeScale({}));
    const body = await (await get('/api/v1')).json();
    expect(body.scalable).toBe(true);
    expect(body.endpoints).toContain('/api/v1/scale/entities');
  });

  it('answers without reading the snapshot, even where an inventory route would 503', async () => {
    // The scale reads call Home Assistant, never the snapshot. That is still true — but since
    // issue #79 the *caller* is resolved against the snapshot, so it must be loaded for anyone
    // to get this far. The distinction is asserted by the 503 test at the end of this file.
    const get = await start(fakeScale({ entities: [] }));
    expect((await get('/api/v1/scale/entities')).status).toBe(200);
  });
});

describe('GET /api/v1/scale/state', () => {
  it('returns a reading reconciled to grams', async () => {
    const get = await start(fakeScale({ reading: READING }));
    const res = await get('/api/v1/scale/state?entity_id=sensor.bench_scale');
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ grams: 1250, value: 1.25, unit: 'kg' });
  });

  it('requires an entity_id', async () => {
    const get = await start(fakeScale({ reading: READING }));
    const res = await get('/api/v1/scale/state');
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe('bad_request');
  });

  it('reports an unavailable scale as a 409, never a zero reading', async () => {
    const get = await start(fakeScale({ reading: { ok: false, issue: 'unavailable' } }));
    const res = await get('/api/v1/scale/state?entity_id=sensor.bench_scale');
    expect(res.status).toBe(409);
    expect((await res.json()).error.code).toBe('scale_unavailable');
  });

  // Issue #179: an entity that isn't a scale is answered as a missing one — a 404 with the generic
  // `not_found` code and no detail — so the endpoint can't be used to probe other HA entities. The
  // real client throws this; the route also collapses an inline `not-a-scale` outcome the same way.
  it('answers a non-scale entity as a plain 404, revealing nothing about it', async () => {
    const get = await start(fakeScale({ reading: { ok: false, issue: 'not-a-scale' } }));
    const res = await get('/api/v1/scale/state?entity_id=sensor.lounge_temperature');
    expect(res.status).toBe(404);
    const { error } = await res.json();
    expect(error.code).toBe('not_found');
    expect(error.message).toBe('No such entity.');
  });

  it('answers a thrown 404 (an unknown entity) identically to a non-scale one', async () => {
    const get = await start(fakeScale({ throws: new HaError(404, 'not_found', 'No such entity.') }));
    const res = await get('/api/v1/scale/state?entity_id=sensor.nope');
    expect(res.status).toBe(404);
    expect((await res.json()).error).toEqual({ code: 'not_found', message: 'No such entity.' });
  });

  it('surfaces a Home Assistant failure with its status, without leaking internals', async () => {
    const get = await start(
      fakeScale({
        throws: new HaError(502, 'home_assistant_unreachable', 'Could not reach Home Assistant.'),
      }),
    );
    const res = await get('/api/v1/scale/state?entity_id=sensor.bench_scale');
    expect(res.status).toBe(502);
    expect((await res.json()).error).toEqual({
      code: 'home_assistant_unreachable',
      message: 'Could not reach Home Assistant.',
    });
  });

  it('collapses an unexpected client error to a generic 500', async () => {
    const get = await start(fakeScale({ throws: new Error('secret internal detail') }));
    const res = await get('/api/v1/scale/state?entity_id=sensor.bench_scale');
    expect(res.status).toBe(500);
    expect(JSON.stringify(await res.json())).not.toContain('secret internal detail');
  });

  it('404s an unknown sub-path under /scale', async () => {
    const get = await start(fakeScale({}));
    expect((await get('/api/v1/scale')).status).toBe(404);
    expect((await get('/api/v1/scale/nonsense')).status).toBe(404);
  });

  it('still requires a valid API token', async () => {
    server = createBridgeServer({ getState: () => state, scale: fakeScale({ reading: READING }) });
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    const res = await fetch(`http://127.0.0.1:${port}/api/v1/scale/entities`);
    expect(res.status).toBe(401);
  });

  // Authentication resolves the presented token against the snapshot, so a bridge that has not
  // loaded one yet cannot identify anybody — and answers 503 rather than letting the request
  // through. Failing closed is the only safe direction for "who is this?" (issue #79).
  it('refuses every route until a snapshot has loaded', async () => {
    server = createBridgeServer({ getState: () => null, scale: fakeScale({ reading: READING }) });
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    const res = await fetch(`http://127.0.0.1:${port}/api/v1/scale/entities`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(503);
  });
});

describe('GET /api/v1/scale/stream', () => {
  it('requires the caller’s token, exactly like every other read', async () => {
    server = createBridgeServer({ getState: () => state, scale: fakeScale({ reading: READING }) });
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    const res = await fetch(`http://127.0.0.1:${port}/api/v1/scale/stream?entity_id=sensor.bench_scale`);
    expect(res.status).toBe(401);
    await res.json();
  });

  it('streams a live reading to an authorised caller', async () => {
    await start(fakeScale({ reading: READING }));
    const controller = new AbortController();
    const { port } = server!.address() as AddressInfo;
    const res = await fetch(`http://127.0.0.1:${port}/api/v1/scale/stream?entity_id=sensor.bench_scale`, {
      headers: { authorization: `Bearer ${TOKEN}` },
      signal: controller.signal,
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/event-stream; charset=utf-8');
    const chunk = new TextDecoder().decode((await res.body!.getReader().read()).value);
    expect(chunk).toContain('"grams":1250');
    controller.abort();
  });

  // A HEAD must not take a client slot or hold a response open, so it reports the media type only.
  it('answers a HEAD probe without opening a stream', async () => {
    const capability = fakeScale({ reading: READING });
    await start(capability);
    const { port } = server!.address() as AddressInfo;
    const res = await fetch(`http://127.0.0.1:${port}/api/v1/scale/stream`, {
      method: 'HEAD',
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/event-stream; charset=utf-8');
    expect(capability.stream.clientCount()).toBe(0);
  });

  it('advertises the path in the discovery index once the capability is on', async () => {
    const get = await start(fakeScale({ reading: READING }));
    const body = await (await get('/api/v1')).json();
    expect(body.endpoints).toContain('/api/v1/scale/stream');
  });
});
