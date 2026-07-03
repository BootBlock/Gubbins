/**
 * Server-level feed + metrics tests (EI-6) over the SYNTHETIC feeds fixture. Drives the real
 * bridge server in-process (ephemeral loopback port) to cover the `GET /api/v1/activity.{rss,atom,
 * json}` and `GET /metrics` wiring: content types, header vs. query-string token auth (feeds
 * only), the metric names/values, and stable entry ids across refetches.
 */
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hydrateFromJson, type HydrateResult } from '../hydrate.ts';
import { createBridgeServer, type BridgeServerState } from '../server.ts';

const FIXTURE_URL = new URL('../fixtures/synthetic-feeds-snapshot.json', import.meta.url);
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

function withHeader(path: string): Promise<Response> {
  return fetch(`${baseUrl}${path}`, { headers: { authorization: `Bearer ${TOKEN}` } });
}

describe('GET /api/v1/activity.rss|.atom|.json', () => {
  it('serves an RSS feed (application/rss+xml) with the newest activity first', async () => {
    const res = await withHeader('/api/v1/activity.rss');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/rss+xml');
    const body = await res.text();
    expect(body.startsWith('<?xml')).toBe(true);
    expect(body).toContain('<title>Gubbins activity</title>');
    // The newest ledger row (hist-6) is the last Flux quantity change.
    expect(body).toContain('<guid isPermaLink="false">urn:gubbins:activity:hist-6</guid>');
    expect(body).toContain('<title>Flux Paste — Quantity changed</title>');
    // The self URL never leaks the token, even when none was used here.
    expect(body).not.toContain('token');
  });

  it('serves an Atom feed (application/atom+xml)', async () => {
    const res = await withHeader('/api/v1/activity.atom');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/atom+xml');
    const body = await res.text();
    expect(body).toContain('<feed xmlns="http://www.w3.org/2005/Atom">');
    expect(body).toContain('<id>urn:gubbins:activity:hist-6</id>');
  });

  it('serves a JSON Feed (application/feed+json) carrying the _gubbins extension', async () => {
    const res = await withHeader('/api/v1/activity.json');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/feed+json');
    const doc = await res.json();
    expect(doc.version).toBe('https://jsonfeed.org/version/1.1');
    expect(doc.items[0].id).toBe('urn:gubbins:activity:hist-6');
    // The soft-deleted item's removal entry carries itemActive:false.
    const removal = doc.items.find(
      (i: { _gubbins: { itemId: string } }) => i._gubbins.itemId === 'item-retired',
    );
    expect(removal._gubbins.itemActive).toBe(false);
  });

  it('honours ?limit= to narrow the window', async () => {
    const doc = await (await withHeader('/api/v1/activity.json?limit=2')).json();
    expect(doc.items).toHaveLength(2);
    expect(doc.items[0].id).toBe('urn:gubbins:activity:hist-6');
  });

  it('accepts the token in the query string (feed readers cannot send an auth header)', async () => {
    const res = await fetch(`${baseUrl}/api/v1/activity.rss?token=${TOKEN}`);
    expect(res.status).toBe(200);
    const body = await res.text();
    // The self URL must strip the token so it is never echoed into the feed body.
    expect(body).not.toContain(TOKEN);
  });

  it('rejects a missing token (401) and a wrong query token (401)', async () => {
    expect((await fetch(`${baseUrl}/api/v1/activity.rss`)).status).toBe(401);
    expect((await fetch(`${baseUrl}/api/v1/activity.rss?token=wrong`)).status).toBe(401);
  });

  it('advertises the feed paths in the discovery index', async () => {
    const index = await (await withHeader('/api/v1')).json();
    expect(index.endpoints).toContain('/api/v1/activity.rss');
    expect(index.endpoints).toContain('/api/v1/activity.atom');
    expect(index.endpoints).toContain('/api/v1/activity.json');
  });

  it('returns stable entry ids across refetches', async () => {
    const ids = (text: string) => text.match(/urn:gubbins:activity:[^<"]+/g)?.sort();
    const first = await (await withHeader('/api/v1/activity.rss')).text();
    const second = await (await withHeader('/api/v1/activity.rss')).text();
    expect(ids(first)).toEqual(ids(second));
    expect(ids(first)?.length).toBeGreaterThan(0);
  });
});

describe('GET /metrics', () => {
  it('serves a Prometheus exposition with the expected counts', async () => {
    const res = await withHeader('/metrics');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/plain');
    expect(res.headers.get('content-type')).toContain('version=0.0.4');
    const body = await res.text();
    // 3 active items; solder(3) + flux(0) low; flux out of stock; 2 user locations.
    expect(body).toContain('\ngubbins_items_total 3\n');
    expect(body).toContain('\ngubbins_low_stock_items 2\n');
    expect(body).toContain('\ngubbins_out_of_stock_items 1\n');
    expect(body).toContain('\ngubbins_locations_total 2\n');
    // Store Room: 2 items, capacity 10 → fullness 0.2. Workbench: 1 item, no capacity.
    expect(body).toContain('gubbins_location_items{location_id="loc-store",location="Store Room"} 2');
    expect(body).toContain('gubbins_location_capacity{location_id="loc-store",location="Store Room"} 10');
    expect(body).toContain(
      'gubbins_location_fullness_ratio{location_id="loc-store",location="Store Room"} 0.2',
    );
    expect(body).toContain('gubbins_location_items{location_id="loc-bench",location="Workbench"} 1');
    expect(body).not.toContain('gubbins_location_capacity{location_id="loc-bench"');
  });

  it('requires the bearer header and does NOT accept a query token', async () => {
    expect((await fetch(`${baseUrl}/metrics`)).status).toBe(401);
    // Metrics is header-only: a URL token (allowed on the feeds) must still be rejected here.
    expect((await fetch(`${baseUrl}/metrics?token=${TOKEN}`)).status).toBe(401);
  });
});
