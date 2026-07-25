/**
 * OData v4 service tests (`/api/v1/odata`) over the SYNTHETIC fixture (no real or personal data).
 *
 * The point of the service is that a real OData client can complete the conversation it always
 * starts: service document → `$metadata` → entity-set read. So these drive that whole sequence
 * over the in-process server, and assert the things a client actually checks — the
 * `OData-Version` header, the `@odata.context`/`value` envelope, `@odata.count`, the paging link
 * — rather than just the row data, which `v1.test.ts` already covers through the REST envelope.
 */
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
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

async function json(path: string): Promise<any> {
  const res = await get(path);
  expect(res.status).toBe(200);
  return res.json();
}

/** The absolute service root the service emits its context URLs and paging links against. */
function serviceRoot(): string {
  return `${baseUrl}/api/v1/odata`;
}

describe('the OData conversation a client actually has', () => {
  it('serves a service document naming the entity sets (Protocol §11.1.1)', async () => {
    const res = await get('/api/v1/odata');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('odata.metadata=minimal');

    const body = await res.json();
    expect(body['@odata.context']).toBe(`${serviceRoot()}/$metadata`);
    expect(body.value).toEqual([
      { name: 'items', kind: 'EntitySet', url: 'items' },
      { name: 'locations', kind: 'EntitySet', url: 'locations' },
      { name: 'categories', kind: 'EntitySet', url: 'categories' },
    ]);
  });

  it('serves $metadata from its own service root', async () => {
    const res = await get('/api/v1/odata/$metadata');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/xml');
    expect(await res.text()).toContain('<EntitySet Name="items"');
  });

  it('answers an entity-set read with the OData JSON envelope, not { data, pagination }', async () => {
    const body = await json('/api/v1/odata/items');
    expect(body['@odata.context']).toBe(`${serviceRoot()}/$metadata#items`);
    expect(Array.isArray(body.value)).toBe(true);
    expect(body.value).toHaveLength(4);
    expect(body.value[0]).toHaveProperty('id');
    // The shapes the old envelope used must not survive alongside it.
    expect(body).not.toHaveProperty('data');
    expect(body).not.toHaveProperty('pagination');
  });

  it('stamps OData-Version on every response for the sub-tree, including the guards', async () => {
    for (const path of ['/api/v1/odata', '/api/v1/odata/$metadata', '/api/v1/odata/items']) {
      expect((await get(path)).headers.get('odata-version')).toBe('4.0');
    }
    // A response written before routing (no token ⇒ 401) is still an OData response.
    const unauthorised = await fetch(`${baseUrl}/api/v1/odata/items`);
    expect(unauthorised.status).toBe(401);
    expect(unauthorised.headers.get('odata-version')).toBe('4.0');
    // …and a cross-origin browser client is allowed to read it back off the response.
    expect((await get('/api/v1/odata/items')).headers.get('access-control-expose-headers')).toContain(
      'OData-Version',
    );
  });

  it("leaves the REST endpoints' envelope untouched", async () => {
    const rest = await json('/api/v1/items');
    expect(rest).toHaveProperty('pagination');
    expect(rest).not.toHaveProperty('@odata.context');
  });
});

describe('entity sets and keys', () => {
  it('reads one entity by key, context-qualified with /$entity', async () => {
    const body = await json("/api/v1/odata/items('item-esp32')");
    expect(body['@odata.context']).toBe(`${serviceRoot()}/$metadata#items/$entity`);
    expect(body.id).toBe('item-esp32');
    // The single-entity payload is the full detail shape, exactly as `/api/v1/items/{id}` gives.
    expect(body).toHaveProperty('placements');
  });

  it('accepts the unquoted and named-key spellings of the same key', async () => {
    for (const path of ['items(item-esp32)', "items(id='item-esp32')"]) {
      expect((await json(`/api/v1/odata/${path}`)).id).toBe('item-esp32');
    }
  });

  it('404s a key that matches nothing', async () => {
    const res = await get("/api/v1/odata/items('nope')");
    expect(res.status).toBe(404);
    expect((await res.json()).error.code).toBe('not_found');
  });

  it('serves locations and categories through the same envelope', async () => {
    const locations = await json('/api/v1/odata/locations');
    expect(locations['@odata.context']).toBe(`${serviceRoot()}/$metadata#locations`);
    expect(locations.value).toHaveLength(5); // 3 fixture + 2 system-seeded

    const one = await json("/api/v1/odata/locations('loc-drawer-a')");
    expect(one).toMatchObject({ id: 'loc-drawer-a', name: 'Drawer A', itemCount: 2 });

    const categories = await json('/api/v1/odata/categories');
    expect(categories.value).toHaveLength(2);
    expect((await json("/api/v1/odata/categories('cat-electronics')")).fields).toBeDefined();
  });

  it('404s an entity set it does not serve', async () => {
    expect((await get('/api/v1/odata/widgets')).status).toBe(404);
    expect((await get('/api/v1/odata/items/nope')).status).toBe(404);
  });
});

describe('query options', () => {
  it('honours $filter, $orderby and $search through the same engine as the REST list', async () => {
    const filtered = await json('/api/v1/odata/items?$filter=quantity gt 10');
    expect(filtered.value).toHaveLength(3);

    const sorted = await json('/api/v1/odata/items?$orderby=quantity desc');
    expect(sorted.value.map((i: any) => i.id)).toEqual([
      'item-resistor',
      'item-m3-washer',
      'item-m3-bolt',
      'item-esp32',
    ]);

    const searched = await json('/api/v1/odata/items?$search=ESP32');
    expect(searched.value.map((i: any) => i.id)).toEqual(['item-esp32']);
  });

  it('reports the inline count as @odata.count, not pagination.total', async () => {
    const body = await json('/api/v1/odata/items?$count=true&$top=2');
    expect(body['@odata.count']).toBe(4);
    expect(body.value).toHaveLength(2);
  });

  it('serves the raw /$count value', async () => {
    const res = await get('/api/v1/odata/items/$count');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/plain');
    expect(await res.text()).toBe('4');
    expect(await (await get('/api/v1/odata/items/$count?$search=ESP32')).text()).toBe('1');
  });

  it('qualifies the context URL with the projection when $select narrows it', async () => {
    const body = await json('/api/v1/odata/items?$select=id,name');
    expect(body['@odata.context']).toBe(`${serviceRoot()}/$metadata#items(id,name)`);
    expect(Object.keys(body.value[0])).toEqual(['id', 'name']);
  });

  it('answers $top=0 with an empty collection rather than a clamped page of one', async () => {
    const body = await json('/api/v1/odata/items?$top=0&$count=true');
    expect(body.value).toEqual([]);
    expect(body['@odata.count']).toBe(4);
    expect(body).not.toHaveProperty('@odata.nextLink');

    // …and it is still a real request: a bad option is a 400, not a waved-through empty page.
    expect((await get('/api/v1/odata/items?$top=0&$filter=quantity ge 1')).status).toBe(400);
    expect((await get('/api/v1/odata/items?$top=0&$orderby=bogus')).status).toBe(400);
    expect((await get('/api/v1/odata/items?$top=0&$select=bogus')).status).toBe(400);
    expect((await json('/api/v1/odata/locations?$top=0')).value).toEqual([]);
  });

  it('refuses a system query option the addressed resource does not support (§11.2.5)', async () => {
    // Silently ignoring it is what made the old surface an OData-flavoured lie.
    const res = await get('/api/v1/odata/locations?$filter=name eq %27Drawer A%27');
    expect(res.status).toBe(400);
    const { error } = await res.json();
    expect(error.code).toBe('bad_request');
    expect(error.message).toContain('$filter');
    expect(error.message).toContain('locations');

    expect((await get('/api/v1/odata/locations/$count')).status).toBe(404);
    expect((await get('/api/v1/odata/items?$apply=groupby((name))')).status).toBe(400);
    expect((await get("/api/v1/odata/items('item-esp32')?$orderby=name")).status).toBe(400);
  });

  it('accepts $format=json and refuses any other representation', async () => {
    expect((await get('/api/v1/odata/items?$format=json')).status).toBe(200);
    expect((await get('/api/v1/odata/items?$format=xml')).status).toBe(400);
  });

  it('rejects a non-integer $top/$skip rather than silently falling back', async () => {
    expect((await get('/api/v1/odata/items?$top=-1')).status).toBe(400);
    expect((await get('/api/v1/odata/items?$skip=abc')).status).toBe(400);
  });

  it('passes an invalid $filter through as a 400 with the supported vocabulary', async () => {
    const res = await get('/api/v1/odata/items?$filter=quantity ge 10');
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe('bad_request');
  });

  it("allows the bridge's own non-$ query options alongside the OData ones", async () => {
    const body = await json('/api/v1/odata/items?location=loc-drawer-a');
    expect(body.value).toHaveLength(2);
  });
});

describe('server-driven paging (@odata.nextLink)', () => {
  it('links to the next page, carrying the query forward and advancing the cursor', async () => {
    const body = await json('/api/v1/odata/items?limit=2&$orderby=name');
    expect(body.value).toHaveLength(2);

    const next = new URL(body['@odata.nextLink']);
    expect(next.pathname).toBe('/api/v1/odata/items');
    expect(next.searchParams.get('$orderby')).toBe('name');
    expect(next.searchParams.get('$skip')).toBe('2');
    // The page size is carried forward, so following the link doesn't silently widen the page.
    expect(next.searchParams.get('limit')).toBe('2');
  });

  it('walks the whole set across the chain without repeating or dropping a row', async () => {
    const seen: string[] = [];
    let link: string | undefined = `${serviceRoot()}/items?limit=2&$orderby=name`;
    for (let hop = 0; link !== undefined && hop < 5; hop += 1) {
      const target = new URL(link);
      const page: any = await (await get(target.pathname + target.search)).json();
      seen.push(...page.value.map((i: any) => i.id));
      link = page['@odata.nextLink'];
    }
    expect(seen).toHaveLength(4);
    expect(new Set(seen).size).toBe(4);
    expect(link).toBeUndefined(); // the chain terminated rather than running out of hops
  });

  it('stops linking once $top has been satisfied — that many rows is the whole result', async () => {
    const body = await json('/api/v1/odata/items?$top=2&$orderby=name');
    expect(body.value).toHaveLength(2);
    expect(body).not.toHaveProperty('@odata.nextLink');
  });

  it('omits the link on the last page', async () => {
    const body = await json('/api/v1/odata/items');
    expect(body).not.toHaveProperty('@odata.nextLink');
  });
});
