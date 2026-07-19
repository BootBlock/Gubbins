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
import rootPackageJson from '../../../package.json' with { type: 'json' };
import { hydrateFromJson, type HydrateResult } from '../hydrate.ts';
import { mintTestToken } from '../fixtures/test-identity.ts';
import { createBridgeServer, type BridgeServerState } from '../server.ts';

const FIXTURE_URL = new URL('../fixtures/synthetic-snapshot.json', import.meta.url);
let TOKEN = '';

let hydrated: HydrateResult;
let server: ReturnType<typeof createBridgeServer>;
let baseUrl: string;

beforeAll(async () => {
  hydrated = await hydrateFromJson(await readFile(fileURLToPath(FIXTURE_URL), 'utf8'));
  // A caller is identified by a per-user token now, so the test mints one for the built-in
  // Admin (unrestricted, like the old shared token) against the hydrated fixture.
  TOKEN = await mintTestToken(hydrated.driver);
  const state: BridgeServerState = {
    driver: hydrated.driver,
    snapshotGeneratedAt: new Date(hydrated.snapshot.generatedAt).toISOString(),
  };
  server = createBridgeServer({ getState: () => state });
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

  it('reports which build the bridge is, so a client can spot a stale one (issue #282)', async () => {
    const body = await json('/api/v1');

    // Asserted against the repository manifest rather than a literal, because that wiring *is*
    // the fix: the bridge has no version of its own to drift, so this checks the whole path
    // (manifest → version.ts → index) without a number anyone must remember to edit.
    expect(body.bridge).toEqual({
      version: rootPackageJson.version,
      schemaVersion: rootPackageJson.schemaVersion,
    });
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

describe('field selection (fields / include)', () => {
  it('search projects to just the named fields (the "only the price" case)', async () => {
    const body = await json('/api/v1/search?q=ESP32&fields=name,unitCost');
    expect(body.matches).toHaveLength(1);
    expect(Object.keys(body.matches[0]).sort()).toEqual(['name', 'unitCost']);
    expect(body.matches[0].name).toBe('ESP32 Dev Board');
    expect(body.matches[0].unitCost).toBeNull(); // present but unpriced in the fixture
  });

  it('search include= adds an extended field on top of the default match shape', async () => {
    const body = await json('/api/v1/search?q=ESP32&include=capabilities');
    const match = body.matches[0];
    // Default search fields are still present…
    expect(match).toMatchObject({ id: 'item-esp32', name: 'ESP32 Dev Board', mpn: 'DEV-ESP32' });
    // …plus the opted-in extended field.
    expect(match.capabilities.some((c: any) => c.key === 'voltage')).toBe(true);
  });

  it('search 400s an unknown field with the v1 envelope', async () => {
    const res = await get('/api/v1/search?q=ESP32&fields=bogus');
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe('bad_request');
    expect(body.error.message).toContain('bogus');
  });

  it('items list projects every row and keeps the pagination envelope', async () => {
    const body = await json('/api/v1/items?fields=id,name');
    expect(body.pagination.count).toBe(4);
    for (const row of body.data) expect(Object.keys(row).sort()).toEqual(['id', 'name']);
  });

  it('items list include= adds an extended field to every row', async () => {
    const body = await json('/api/v1/items?include=notes&limit=1');
    expect(body.data[0]).toHaveProperty('notes');
    expect(body.data[0]).toHaveProperty('trackingMode'); // defaults retained
  });

  it('item detail supports a nested sparse fieldset', async () => {
    const body = await json('/api/v1/items/item-esp32?fields=name,placements.quantity');
    expect(Object.keys(body).sort()).toEqual(['name', 'placements']);
    for (const p of body.placements) expect(Object.keys(p)).toEqual(['quantity']);
    expect(body.placements.reduce((n: number, p: any) => n + p.quantity, 0)).toBe(7);
  });

  it('item detail include= adds extended fields beyond the default detail payload', async () => {
    const body = await json('/api/v1/items/item-esp32?include=notes,operationalMetadata');
    expect(body).toHaveProperty('notes');
    expect(body).toHaveProperty('operationalMetadata');
    expect(body).toHaveProperty('capabilities'); // default detail fields retained
  });

  it('item detail 400s an unknown field', async () => {
    const res = await get('/api/v1/items/item-esp32?fields=nope');
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe('bad_request');
  });

  it('the default (no-param) responses are unchanged', async () => {
    // A guard that the projection path is strictly additive: no params → today's shapes.
    const search = await json('/api/v1/search?q=ESP32');
    expect(Object.keys(search.matches[0]).sort()).toEqual([
      'id',
      'locationId',
      'locationName',
      'manufacturer',
      'mpn',
      'name',
      'quantity',
    ]);
  });
});

describe('OData-style query options', () => {
  it('$select / $expand / $top alias fields / include / limit', async () => {
    const items = await json('/api/v1/items?$select=id,name');
    for (const row of items.data) expect(Object.keys(row).sort()).toEqual(['id', 'name']);

    const search = await json('/api/v1/search?q=M3&$top=1&$select=name');
    expect(search.matches).toHaveLength(1);
    expect(Object.keys(search.matches[0])).toEqual(['name']);

    const expanded = await json('/api/v1/items/item-esp32?$expand=notes');
    expect(expanded).toHaveProperty('notes');
  });

  it('keeps the OData options off the frozen legacy /search path', async () => {
    // $top is a versioned-API alias only; the unversioned /search must ignore it (default 5),
    // so M3 still returns both fixture matches rather than being capped to 1.
    const legacy = await json('/search?q=M3&$top=1');
    expect(legacy.matches.length).toBeGreaterThan(1);
    // …whereas the versioned endpoint honours it.
    const v1 = await json('/api/v1/search?q=M3&$top=1');
    expect(v1.matches).toHaveLength(1);
  });

  it('$top / $skip alias limit / offset on the list endpoints', async () => {
    const page = await json('/api/v1/items?$top=2&$skip=2&$orderby=quantity');
    expect(page.data).toHaveLength(2);
    expect(page.pagination).toMatchObject({ limit: 2, offset: 2 });
  });

  it('$orderby sorts (NULLs and ties handled), honouring direction', async () => {
    const desc = await json('/api/v1/items?$orderby=quantity desc');
    expect(desc.data.map((i: any) => i.quantity)).toEqual([200, 100, 42, 7]);

    const asc = await json('/api/v1/items?$orderby=quantity');
    expect(asc.data.map((i: any) => i.quantity)).toEqual([7, 42, 100, 200]);
  });

  it('$filter compiles to the search AST: comparison', async () => {
    const body = await json('/api/v1/items?$filter=quantity gt 10&$orderby=quantity');
    expect(body.data.map((i: any) => i.id)).toEqual(['item-m3-bolt', 'item-m3-washer', 'item-resistor']);
  });

  it('$filter compiles the contains() function to an FTS match', async () => {
    const body = await json("/api/v1/items?$filter=contains(name,'ESP32')");
    expect(body.data.map((i: any) => i.id)).toEqual(['item-esp32']);
  });

  it('$filter composes with and/or', async () => {
    const body = await json(
      "/api/v1/items?$filter=quantity gt 50 or contains(name,'ESP32')&$orderby=quantity",
    );
    expect(body.data.map((i: any) => i.id)).toEqual(['item-esp32', 'item-m3-washer', 'item-resistor']);
  });

  it('$filter projects and sorts together', async () => {
    const body = await json("/api/v1/items?$filter=contains(name,'M3')&$select=name&$orderby=name");
    expect(body.data.map((i: any) => i.name)).toEqual(['M3 Nylon Washer', 'M3 x 10 Hex Bolt']);
    for (const row of body.data) expect(Object.keys(row)).toEqual(['name']);
  });

  it('400s an unsupported $filter operator, unknown field, and bad $orderby', async () => {
    expect((await get('/api/v1/items?$filter=quantity ge 10')).status).toBe(400);
    expect((await get('/api/v1/items?$filter=bogus eq 1')).status).toBe(400);
    expect((await get('/api/v1/items?$orderby=bogus')).status).toBe(400);
    const body = await (await get('/api/v1/items?$filter=quantity ge 10')).json();
    expect(body.error.code).toBe('bad_request');
  });

  it('$count=true adds the grand total across all pages', async () => {
    const body = await json('/api/v1/items?$top=2&$count=true');
    expect(body.data).toHaveLength(2);
    expect(body.pagination.total).toBe(4);
    expect(body.pagination.hasMore).toBe(true);

    const filtered = await json('/api/v1/items?$filter=quantity gt 10&$count=true');
    expect(filtered.pagination.total).toBe(3);

    // Omitting $count leaves total absent (it costs an extra query).
    const plain = await json('/api/v1/items');
    expect(plain.pagination.total).toBeUndefined();
  });

  it('GET /items/$count returns a bare text/plain integer honouring $filter/$search', async () => {
    const all = await get('/api/v1/items/$count');
    expect(all.status).toBe(200);
    expect(all.headers.get('content-type')).toContain('text/plain');
    expect(await all.text()).toBe('4');

    expect(await (await get('/api/v1/items/$count?$filter=quantity gt 10')).text()).toBe('3');
    expect(await (await get('/api/v1/items/$count?$search=ESP32')).text()).toBe('1');
    expect((await get('/api/v1/items/$count?$filter=bogus eq 1')).status).toBe(400);
  });

  it('$search does a free-text (FTS) match on the list', async () => {
    const body = await json('/api/v1/items?$search=ESP32');
    expect(body.data.map((i: any) => i.id)).toEqual(['item-esp32']);
  });

  it('serves the OData $metadata CSDL document (state-independent)', async () => {
    const res = await get('/api/v1/$metadata');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/xml');
    const xml = await res.text();
    expect(xml).toContain('<EntityType Name="Item">');
    expect(xml).toContain('<EntitySet Name="items"');
  });

  it('lists $metadata and items/$count in the discovery index', async () => {
    const index = await json('/api/v1');
    expect(index.endpoints).toContain('/api/v1/$metadata');
    expect(index.endpoints).toContain('/api/v1/items/$count');
  });
});

describe('CSV export (GET /api/v1/items.csv)', () => {
  const HEADER =
    'id,name,description,notes,trackingMode,quantity,isUnlimited,mpn,manufacturer,unitCost,weight,width,height,depth';

  async function csvLines(path: string): Promise<string[]> {
    const res = await get(path);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/csv');
    return (await res.text()).split('\r\n');
  }

  it('serves a downloadable CSV with the export column header and every item', async () => {
    const res = await get('/api/v1/items.csv');
    expect(res.headers.get('content-type')).toContain('text/csv');
    expect(res.headers.get('content-disposition')).toContain('attachment');
    const lines = (await res.text()).split('\r\n');
    expect(lines[0]).toBe(HEADER);
    expect(lines).toHaveLength(1 + 4); // header + the 4 fixture items
  });

  it('honours $orderby', async () => {
    const lines = await csvLines('/api/v1/items.csv?$orderby=quantity desc');
    // Assert on the id (column 0 — never quoted, unlike descriptions that may contain commas).
    const ids = lines.slice(1).map((l) => l.split(',')[0]);
    expect(ids).toEqual(['item-resistor', 'item-m3-washer', 'item-m3-bolt', 'item-esp32']);
  });

  it('honours $filter and $search', async () => {
    const filtered = await csvLines('/api/v1/items.csv?$filter=quantity gt 10');
    expect(filtered.slice(1)).toHaveLength(3);

    const searched = await csvLines('/api/v1/items.csv?$search=ESP32');
    const rows = searched.slice(1);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toContain('item-esp32');
  });

  it('400s an invalid $filter', async () => {
    const res = await get('/api/v1/items.csv?$filter=quantity ge 10');
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe('bad_request');
  });

  it('is listed in the discovery index', async () => {
    expect((await json('/api/v1')).endpoints).toContain('/api/v1/items.csv');
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
