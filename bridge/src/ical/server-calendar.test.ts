/**
 * Server-level calendar-feed tests (EI-2) over the SYNTHETIC calendar fixture. Drives the real
 * bridge server in-process (ephemeral loopback port) to cover the `GET /api/v1/calendar.ics`
 * wiring: content type, header vs. query-string token auth, the `?type=` selector + its 400,
 * the discovery-index entry, and UID stability across refetches.
 */
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hydrateFromJson, type HydrateResult } from '../hydrate.ts';
import { mintTestToken } from '../fixtures/test-identity.ts';
import { createBridgeServer, type BridgeServerState } from '../server.ts';

const FIXTURE_URL = new URL('../fixtures/synthetic-calendar-snapshot.json', import.meta.url);
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

function withHeader(path: string): Promise<Response> {
  return fetch(`${baseUrl}${path}`, { headers: { authorization: `Bearer ${TOKEN}` } });
}

describe('GET /api/v1/calendar.ics', () => {
  it('serves a text/calendar VCALENDAR with the bearer header', async () => {
    const res = await withHeader('/api/v1/calendar.ics');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/calendar');
    const body = await res.text();
    expect(body.startsWith('BEGIN:VCALENDAR')).toBe(true);
    // One representative UID from each source proves the feed assembled end to end.
    expect(body).toContain('UID:loan-checkout-open-due@gubbins.invalid');
    expect(body).toContain('UID:booking-booking-active@gubbins.invalid');
    expect(body).toContain('UID:maintenance-sched-time-drill@gubbins.invalid');
    expect(body).toContain('UID:warranty-item-drill@gubbins.invalid');
    // DTSTAMP is the snapshot's generation instant (stable across refetches).
    expect(body).toContain('DTSTAMP:20250627T045320Z');
  });

  it('accepts the token in the query string (calendar clients cannot send an auth header)', async () => {
    const res = await fetch(`${baseUrl}/api/v1/calendar.ics?token=${TOKEN}`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/calendar');
  });

  it('rejects a missing token (401) and a wrong query token (401)', async () => {
    expect((await fetch(`${baseUrl}/api/v1/calendar.ics`)).status).toBe(401);
    expect((await fetch(`${baseUrl}/api/v1/calendar.ics?token=wrong`)).status).toBe(401);
  });

  it('does NOT accept a query token on a non-calendar path', async () => {
    // The token-in-URL posture is scoped to the calendar path only.
    expect((await fetch(`${baseUrl}/api/v1/items?token=${TOKEN}`)).status).toBe(401);
  });

  it('narrows to a single source with ?type=', async () => {
    const body = await (await withHeader('/api/v1/calendar.ics?type=warranty')).text();
    expect(body).toContain('UID:warranty-item-drill@gubbins.invalid');
    expect(body).not.toContain('UID:loan-');
    expect(body).not.toContain('UID:booking-');
  });

  it('accepts a comma-separated subset and rejects an unknown type with a 400', async () => {
    const ok = await withHeader('/api/v1/calendar.ics?type=loans,warranty');
    expect(ok.status).toBe(200);

    const bad = await withHeader('/api/v1/calendar.ics?type=loans,bogus');
    expect(bad.status).toBe(400);
    expect((await bad.json()).error.code).toBe('bad_request');
  });

  it('returns stable UIDs across refetches', async () => {
    const first = await (await withHeader('/api/v1/calendar.ics')).text();
    const second = await (await withHeader('/api/v1/calendar.ics')).text();
    const uids = (text: string) =>
      text
        .match(/^UID:.*$/gm)
        ?.map((l) => l.trim())
        .sort();
    expect(uids(first)).toEqual(uids(second));
    expect(uids(first)?.length).toBeGreaterThan(0);
  });

  it('advertises calendar.ics in the discovery index', async () => {
    const index = await (await withHeader('/api/v1')).json();
    expect(index.endpoints).toContain('/api/v1/calendar.ics');
  });
});
