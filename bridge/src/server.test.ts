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
import { createBridgeServer, type BridgeServerState } from './server.ts';
import { createRateLimiter } from './rate-limit.ts';

const FIXTURE_URL = new URL('./fixtures/synthetic-snapshot.json', import.meta.url);
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
      token: TOKEN,
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
    const empty = createBridgeServer({ token: TOKEN, getState: () => null });
    await new Promise<void>((resolve) => empty.listen(0, '127.0.0.1', resolve));
    try {
      const { port } = empty.address() as AddressInfo;
      const res = await fetch(`http://127.0.0.1:${port}/health`, {
        headers: { authorization: `Bearer ${TOKEN}` },
      });
      expect(res.status).toBe(503);
      expect((await res.json()).ok).toBe(false);
    } finally {
      await new Promise<void>((resolve) => empty.close(() => resolve()));
    }
  });
});
