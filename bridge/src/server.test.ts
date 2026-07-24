/**
 * Phase HA-3 HTTP-server tests over the SYNTHETIC fixture (no real or personal data).
 *
 * The server is driven in-process: a hydrated fixture driver is injected via `getState`
 * and the server is bound to an ephemeral loopback port, so no external network and no
 * real data are involved. Each endpoint's JSON is asserted, plus the 401 (missing/wrong
 * token), 405, 404 and 400 guards.
 */
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hydrateFromJson, type HydrateResult } from './hydrate.ts';
import { mintTestToken } from './fixtures/test-identity.ts';
import { createBridgeServer, requestBase, type BridgeServerState } from './server.ts';
import { createRateLimiter } from './rate-limit.ts';
import { HEALTHY_RELOAD, summarizeSnapshotHealth } from './snapshot-health.ts';

const FIXTURE_URL = new URL('./fixtures/synthetic-snapshot.json', import.meta.url);
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

/** GET with the valid bearer token unless one is supplied explicitly. */
function get(path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`${baseUrl}${path}`, {
    headers: { authorization: `Bearer ${TOKEN}`, ...(init.headers ?? {}) },
    ...init,
  });
}

describe('GET /health', () => {
  it('reports ok, the item count, and the snapshot timestamp', async () => {
    const res = await get('/health');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.itemCount).toBe(4);
    expect(typeof body.snapshotGeneratedAt).toBe('string');
  });

  it('reports a fresh snapshot when no reload-health accessor is wired', async () => {
    const body = await (await get('/health')).json();
    expect(body).toMatchObject({
      snapshotStale: false,
      reloadFailures: 0,
      lastReloadError: null,
      lastReloadErrorAt: null,
      lastReloadAt: null,
    });
  });

  // Issue #394: with no reload-health accessor wired the staleness header is simply absent — its
  // presence is itself the signal that the bridge reports staleness at all.
  it('omits the staleness header when no reload-health accessor is wired', async () => {
    const res = await get('/health');
    expect(res.headers.get('x-gubbins-snapshot-stale')).toBeNull();
  });

  // Issue #312: a failed re-hydrate keeps the last good snapshot serving, so /health has to stop
  // claiming `ok` once the data is knowingly out of date — otherwise a dashboard renders stale
  // stock levels as if they were current.
  it('drops ok and reports the failures once the snapshot has gone stale', async () => {
    let report = summarizeSnapshotHealth(HEALTHY_RELOAD);
    const stale = createBridgeServer({
      getState: () => ({
        driver: hydrated.driver,
        snapshotGeneratedAt: new Date(hydrated.snapshot.generatedAt).toISOString(),
      }),
      getSnapshotHealth: () => report,
    });
    await new Promise<void>((resolve) => stale.listen(0, '127.0.0.1', resolve));
    const { port } = stale.address() as AddressInfo;
    const health = (path: string) =>
      fetch(`http://127.0.0.1:${port}${path}`, { headers: { authorization: `Bearer ${TOKEN}` } }).then((r) =>
        r.json(),
      );

    const head = (path: string) =>
      fetch(`http://127.0.0.1:${port}${path}`, { headers: { authorization: `Bearer ${TOKEN}` } });

    try {
      expect(await health('/health')).toMatchObject({ ok: true, snapshotStale: false });
      // Issue #394: the staleness verdict also rides every read as a response header, so a
      // consumer of /search or any /api/v1 read learns about it without polling /health.
      const fresh = await head('/search?q=ESP32');
      expect(fresh.headers.get('x-gubbins-snapshot-stale')).toBe('false');
      // …and it is exposed for CORS, so a cross-origin browser (the PWA) can actually read it.
      expect(fresh.headers.get('access-control-expose-headers')).toContain('X-Gubbins-Snapshot-Stale');

      // Set only after the auth gate: an unauthenticated caller never learns the verdict.
      const unauth = await fetch(`http://127.0.0.1:${port}/search?q=ESP32`);
      expect(unauth.status).toBe(401);
      expect(unauth.headers.get('x-gubbins-snapshot-stale')).toBeNull();

      report = summarizeSnapshotHealth({
        consecutiveFailures: 3,
        lastError: "ENOENT: no such file or directory, open '/srv/gubbins-sync.json'",
        lastErrorAt: '2026-07-19T10:05:00.000Z',
        lastSuccessAt: '2026-07-19T10:00:00.000Z',
      });
      const expected = {
        ok: false,
        snapshotStale: true,
        reloadFailures: 3,
        // The path is redacted: a response never carries the operator's directory layout.
        lastReloadError: "ENOENT: no such file or directory, open '<path>'",
        lastReloadErrorAt: '2026-07-19T10:05:00.000Z',
        lastReloadAt: '2026-07-19T10:00:00.000Z',
      };
      // Both surfaces agree — the versioned alias is not allowed to be more optimistic.
      expect(await health('/health')).toMatchObject(expected);
      expect(await health('/api/v1/health')).toMatchObject(expected);
      // The header flips with the verdict, and covers a plain data read as well as /health.
      expect((await head('/health')).headers.get('x-gubbins-snapshot-stale')).toBe('true');
      expect((await head('/search?q=ESP32')).headers.get('x-gubbins-snapshot-stale')).toBe('true');
    } finally {
      await new Promise<void>((resolve) => stale.close(() => resolve()));
    }
  });
});

describe('GET /search', () => {
  it('returns compact item DTOs for a hit', async () => {
    const res = await get('/search?q=ESP32%20Dev%20Board');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.query).toBe('ESP32 Dev Board');
    expect(body.matches).toEqual([
      {
        id: 'item-esp32',
        name: 'ESP32 Dev Board',
        quantity: 7,
        locationId: 'loc-shelf-2',
        locationName: 'Shelf 2',
        mpn: 'DEV-ESP32',
        manufacturer: 'Synthetic Silicon Co',
      },
    ]);
  });

  it('clamps the limit via the query core', async () => {
    const res = await get('/search?q=M3&limit=1');
    const body = await res.json();
    expect(body.matches).toHaveLength(1);
  });

  it('rejects a missing q with 400', async () => {
    expect((await get('/search')).status).toBe(400);
  });

  it('rejects an over-long q with 400', async () => {
    expect((await get(`/search?q=${'x'.repeat(500)}`)).status).toBe(400);
  });
});

describe('GET /where', () => {
  it('returns the breakdown and a spoken sentence', async () => {
    const res = await get('/where?q=ESP32');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.query).toBe('ESP32');
    expect(body.matches).toHaveLength(1);
    const byLocation = new Map(
      body.matches[0].placements.map((p: { locationName: string; quantity: number }) => [
        p.locationName,
        p.quantity,
      ]),
    );
    expect(byLocation.get('Shelf 2')).toBe(5);
    expect(byLocation.get('Bin 4')).toBe(2);
    expect(body.spoken).toContain('ESP32 Dev Board');
  });
});

describe('auth and method guards', () => {
  it('401s when the token is missing', async () => {
    const res = await fetch(`${baseUrl}/health`);
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toBe('Bearer');
  });

  it('401s when the token is wrong', async () => {
    const res = await fetch(`${baseUrl}/health`, {
      headers: { authorization: 'Bearer the-wrong-token' },
    });
    expect(res.status).toBe(401);
  });

  it('405s a non-GET method', async () => {
    expect((await get('/search?q=M3', { method: 'POST' })).status).toBe(405);
  });

  it('404s an unknown path', async () => {
    expect((await get('/nope')).status).toBe(404);
  });
});

describe('rate limiting', () => {
  it('429s once the per-client bucket is empty, with a Retry-After', async () => {
    const state: BridgeServerState = {
      driver: hydrated.driver,
      snapshotGeneratedAt: new Date(hydrated.snapshot.generatedAt).toISOString(),
    };
    const limited = createBridgeServer({
      getState: () => state,
      rateLimiter: createRateLimiter({ capacity: 2, refillPerSec: 1, now: () => 0 }),
    });
    await new Promise<void>((resolve) => limited.listen(0, '127.0.0.1', resolve));
    try {
      const { port } = limited.address() as AddressInfo;
      const hit = (): Promise<Response> =>
        fetch(`http://127.0.0.1:${port}/health`, {
          headers: { authorization: `Bearer ${TOKEN}` },
        });
      expect((await hit()).status).toBe(200);
      expect((await hit()).status).toBe(200);
      const blocked = await hit();
      expect(blocked.status).toBe(429);
      expect(Number(blocked.headers.get('retry-after'))).toBeGreaterThanOrEqual(1);
    } finally {
      await new Promise<void>((resolve) => limited.close(() => resolve()));
    }
  });
});

describe('503 before a snapshot is loaded', () => {
  it('answers 503 when state is null', async () => {
    const empty = createBridgeServer({ getState: () => null });
    await new Promise<void>((resolve) => empty.listen(0, '127.0.0.1', resolve));
    try {
      const { port } = empty.address() as AddressInfo;
      const res = await fetch(`http://127.0.0.1:${port}/health`, {
        headers: { authorization: `Bearer ${TOKEN}` },
      });
      expect(res.status).toBe(503);
      // The flat legacy envelope, the same as every other unversioned error — plus the
      // Retry-After RFC 9110 §15.6.4 recommends, since the watcher will re-hydrate shortly.
      expect(await res.json()).toEqual({ error: 'Snapshot not loaded yet' });
      expect(Number(res.headers.get('retry-after'))).toBeGreaterThan(0);
    } finally {
      await new Promise<void>((resolve) => empty.close(() => resolve()));
    }
  });
});

describe('requestBase', () => {
  it('resolves the base from the Host header so absolute URLs carry the real address', () => {
    expect(requestBase('192.168.1.20:8787')).toBe('http://192.168.1.20:8787');
    expect(requestBase('gubbins.example.com')).toBe('http://gubbins.example.com');
  });

  it('falls back to localhost when the header is missing, empty or not a bare authority', () => {
    expect(requestBase(undefined)).toBe('http://localhost');
    expect(requestBase('')).toBe('http://localhost');
    // Userinfo, a path, a query, a fragment or a backslash mean this is not an authority.
    expect(requestBase('user@evil.example')).toBe('http://localhost');
    expect(requestBase('example.test/path')).toBe('http://localhost');
    expect(requestBase('example.test?a=b')).toBe('http://localhost');
    expect(requestBase('example.test#frag')).toBe('http://localhost');
    expect(requestBase('example.test\\evil')).toBe('http://localhost');
    expect(requestBase(':')).toBe('http://localhost');
  });
});
