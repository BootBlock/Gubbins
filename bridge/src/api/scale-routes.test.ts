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
 */
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { createBridgeServer, type ScaleCapability } from '../server.ts';
import { HaError } from '../homeassistant/client.ts';
import type { ScaleEntityDto, ScaleReadingOutcome } from '../homeassistant/scale.ts';

const TOKEN = 'placeholder-token-for-tests';

let server: ReturnType<typeof createBridgeServer> | undefined;

afterEach(async () => {
  if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
  server = undefined;
});

/**
 * Start a server with the given scale capability (omit for "the operator never opted in") and
 * return a bound GET helper. `getState` returns null throughout: the scale endpoints read Home
 * Assistant, not the snapshot, and must work before one has loaded.
 */
async function start(scale?: ScaleCapability) {
  server = createBridgeServer({ token: TOKEN, getState: () => null, scale });
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
}): ScaleCapability {
  return {
    client: {
      listScaleEntities: async () => {
        if (overrides.throws) throw overrides.throws;
        return overrides.entities ?? [];
      },
      readScale: async () => {
        if (overrides.throws) throw overrides.throws;
        return overrides.reading ?? { ok: false, issue: 'unavailable', unit: null };
      },
    },
  };
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
  it('answers 404 for both scale paths, so the feature is invisible', async () => {
    const get = await start();
    expect((await get('/api/v1/scale/entities')).status).toBe(404);
    expect((await get('/api/v1/scale/state?entity_id=sensor.bench_scale')).status).toBe(404);
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

  it('still answers before a snapshot has loaded (it does not read the snapshot)', async () => {
    // `getState` returns null throughout `start`, so a 200 here IS the assertion: every other
    // data endpoint would answer 503 in this state.
    const get = await start(fakeScale({ entities: [] }));
    expect((await get('/api/v1/scale/entities')).status).toBe(200);
    expect((await get('/api/v1/items')).status).toBe(503);
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
    const get = await start(fakeScale({ reading: { ok: false, issue: 'unavailable', unit: 'g' } }));
    const res = await get('/api/v1/scale/state?entity_id=sensor.bench_scale');
    expect(res.status).toBe(409);
    expect((await res.json()).error.code).toBe('scale_unavailable');
  });

  it('names the offending unit and the supported ones when it cannot convert', async () => {
    const get = await start(fakeScale({ reading: { ok: false, issue: 'unsupported-unit', unit: 'ml' } }));
    const res = await get('/api/v1/scale/state?entity_id=sensor.bench_scale');
    expect(res.status).toBe(409);
    const { error } = await res.json();
    expect(error.code).toBe('scale_unsupported_unit');
    expect(error.message).toContain('ml');
    expect(error.message).toContain('kg');
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

  it('still requires the bridge bearer token', async () => {
    server = createBridgeServer({
      token: TOKEN,
      getState: () => null,
      scale: fakeScale({ reading: READING }),
    });
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    const res = await fetch(`http://127.0.0.1:${port}/api/v1/scale/entities`);
    expect(res.status).toBe(401);
  });
});
