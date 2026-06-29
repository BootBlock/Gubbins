/**
 * Versioned API (`/api/v1`) tests over the SYNTHETIC fixture (no real or personal data).
 *
 * The server is driven in-process: a hydrated fixture driver is injected via `getState` and
 * the server is bound to an ephemeral loopback port. Covers every new endpoint's shape,
 * pagination bounds, the v1 error envelope, 404s, auth, and the alias relationship with the
 * legacy paths the Home Assistant integration depends on.
 */
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hydrateFromJson, type HydrateResult } from '../hydrate.ts';
import { createBridgeServer, type BridgeServerState } from '../server.ts';

const FIXTURE_URL = new URL('../fixtures/synthetic-snapshot.json', import.meta.url);
const TOKEN = 'placeholder-token-for-tests';

let hydrated: HydrateResult;
let server: ReturnType<typeof createBridgeServer>;
let baseUrl: string;

beforeAll(async () => {
  hydrated = await hydrateFromJson(await readFile(fileURLToPath(FIXTURE_URL), 'utf8'));
  const state: BridgeServerState = {
    driver: hydrated.driver,
    snapshotGeneratedAt: new Date(hydrated.snapshot.generatedAt).toISOString(),
  };
  server = createBridgeServer({ token: TOKEN, getState: () => state });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await hydrated.driver.close();
});

function get(path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`${baseUrl}${path}`, {
    headers: { authorization: `Bearer ${TOKEN}`, ...(init.headers ?? {}) },
    ...init,
  });
}

async function json(path: string, init?: RequestInit): Promise<any> {
  return (await get(path, init)).json();
}

describe('meta endpoints', () => {
  it('serves an API index', async () => {
    const res = await get('/api/v1');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.version).toBe('1.0.0');
    expect(body.openapi).toBe('/api/v1/openapi.json');
    expect(Array.isArray(body.endpoints)).toBe(true);
  });

  it('serves the OpenAPI document', async () => {
    const res = await get('/api/v1/openapi.json');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.openapi).toBe('3.0.3');
    expect(body.paths['/api/v1/items']).toBeDefined();
  });

  it('serves health (same body as the legacy alias)', async () => {
    const v1 = await json('/api/v1/health');
    const legacy = await json('/health');
    expect(v1).toEqual(legacy);
    expect(v1.itemCount).toBe(4);
  });
});

describe('search / where are aliases of the legacy contract', () => {
  it('/api/v1/search deep-equals /search', async () => {
    expect(await json('/api/v1/search?q=ESP32')).toEqual(await json('/search?q=ESP32'));
  });

  it('/api/v1/where deep-equals /where', async () => {
    expect(await json('/api/v1/where?q=ESP32')).toEqual(await json('/where?q=ESP32'));
  });

  it('uses the v1 error envelope for a missing q', async () => {
    const res = await get('/api/v1/search');
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe('bad_request');
  });
});

describe('GET /api/v1/items', () => {
  it('returns a paginated envelope with resolved location names', async () => {
    const res = await get('/api/v1/items');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.pagination).toEqual({ limit: 50, offset: 0, count: 4, hasMore: false });
    const bolt = body.data.find((i: any) => i.id === 'item-m3-bolt');
    expect(bolt).toMatchObject({
      name: 'M3 x 10 Hex Bolt',
      quantity: 42,
      locationId: 'loc-drawer-a',
      locationName: 'Drawer A',
      categoryId: 'cat-fasteners',
      trackingMode: 'DISCRETE',
      isActive: true,
    });
  });

  it('pages with limit/offset and reports hasMore when a full page comes back', async () => {
    // 4 items total. A partial last page flips hasMore to false.
    const page1 = await json('/api/v1/items?limit=3');
    expect(page1.data).toHaveLength(3);
    expect(page1.pagination).toMatchObject({ limit: 3, offset: 0, hasMore: true });

    const page2 = await json('/api/v1/items?limit=3&offset=3');
    expect(page2.data).toHaveLength(1);
    expect(page2.pagination.hasMore).toBe(false);
  });

  it('clamps an over-large limit to the hard ceiling (100)', async () => {
    const body = await json('/api/v1/items?limit=9999');
    expect(body.pagination.limit).toBe(100);
  });

  it('returns an empty page past the end', async () => {
    const body = await json('/api/v1/items?offset=9999');
    expect(body.data).toHaveLength(0);
    expect(body.pagination.hasMore).toBe(false);
  });

  it('filters by location and category', async () => {
    const byLocation = await json('/api/v1/items?location=loc-drawer-a');
    expect(byLocation.data.map((i: any) => i.id).sort()).toEqual(['item-m3-bolt', 'item-m3-washer']);

    const byCategory = await json('/api/v1/items?category=cat-electronics');
    expect(byCategory.data.map((i: any) => i.id).sort()).toEqual(['item-esp32', 'item-resistor']);
  });
});

describe('GET /api/v1/items/{id}', () => {
  it('returns full detail with placements and capabilities', async () => {
    const res = await get('/api/v1/items/item-esp32');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({
      id: 'item-esp32',
      name: 'ESP32 Dev Board',
      locationName: 'Shelf 2',
      categoryName: 'Electronics',
      quantity: 7,
    });
    const byLocation = new Map(body.placements.map((p: any) => [p.locationName, p.quantity]));
    expect(byLocation.get('Shelf 2')).toBe(5);
    expect(byLocation.get('Bin 4')).toBe(2);
    const voltage = body.capabilities.find((c: any) => c.key === 'voltage');
    expect(voltage).toMatchObject({ valueNum: 3.3, valueText: null, weight: 2 });
  });

  it('404s an unknown id with the v1 envelope', async () => {
    const res = await get('/api/v1/items/does-not-exist');
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error.code).toBe('not_found');
    expect(typeof body.error.message).toBe('string');
  });
});

describe('GET /api/v1/locations', () => {
  it('lists locations with live item counts (incl. the seeded system locations)', async () => {
    const body = await json('/api/v1/locations');
    // 3 fixture locations + the 2 system-seeded ones (Unassigned, In Transit).
    expect(body.pagination.count).toBe(5);
    const drawer = body.data.find((l: any) => l.id === 'loc-drawer-a');
    expect(drawer).toMatchObject({ name: 'Drawer A', isSystem: false, itemCount: 2 });
    expect(body.data.some((l: any) => l.isSystem)).toBe(true);
  });

  it('looks one up by id', async () => {
    const body = await json('/api/v1/locations/loc-drawer-a');
    expect(body).toMatchObject({ id: 'loc-drawer-a', name: 'Drawer A', itemCount: 2 });
  });

  it('404s an unknown location', async () => {
    expect((await get('/api/v1/locations/nope')).status).toBe(404);
  });
});

describe('GET /api/v1/categories', () => {
  it('lists categories with field counts', async () => {
    const body = await json('/api/v1/categories');
    expect(body.pagination.count).toBe(2);
    expect(body.data.find((c: any) => c.id === 'cat-electronics')).toMatchObject({
      name: 'Electronics',
      fieldCount: 0,
    });
  });

  it('looks one up by id with its (empty) field schema', async () => {
    const body = await json('/api/v1/categories/cat-electronics');
    expect(body).toMatchObject({ id: 'cat-electronics', name: 'Electronics' });
    expect(Array.isArray(body.fields)).toBe(true);
  });

  it('404s an unknown category', async () => {
    expect((await get('/api/v1/categories/nope')).status).toBe(404);
  });
});

describe('GET /api/v1/capabilities', () => {
  it('lists the queryable capability vocabulary', async () => {
    const body = await json('/api/v1/capabilities');
    const byKey = new Map(body.data.map((c: any) => [c.key, c]));
    expect(byKey.get('voltage')).toMatchObject({
      itemCount: 1,
      hasNumericValues: true,
      hasTextValues: false,
    });
    expect(byKey.has('cores')).toBe(true);
  });
});

describe('routing, auth and method guards', () => {
  it('404s an unknown v1 path', async () => {
    expect((await get('/api/v1/bogus')).status).toBe(404);
    expect((await get('/api/v1/items/a/b')).status).toBe(404);
  });

  it('401s a v1 request with no token, in the v1 envelope', async () => {
    const res = await fetch(`${baseUrl}/api/v1/items`);
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toBe('Bearer');
    expect((await res.json()).error.code).toBe('unauthorized');
  });

  it('405s a non-GET v1 request', async () => {
    const res = await get('/api/v1/items', { method: 'POST' });
    expect(res.status).toBe(405);
    expect((await res.json()).error.code).toBe('method_not_allowed');
  });

  it('keeps the legacy flat error envelope on the unversioned paths', async () => {
    const res = await fetch(`${baseUrl}/health`);
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'Unauthorised' });
  });
});
