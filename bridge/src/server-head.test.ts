/**
 * `HEAD` tests over the SYNTHETIC fixture (no real or personal data) — issue #360.
 *
 * HEAD must be answered exactly as the GET is, minus the content (RFC 9110 §9.3.2): same status,
 * same headers — including the `Content-Length` the GET would have reported, which is what a
 * calendar or feed subscriber uses to spot a change before downloading. So each case here asserts
 * the HEAD against the *actual* GET response rather than against a hard-coded expectation, and
 * asserts the body really is empty. The guards (`401`, `404`, `405`) are covered too, since a probe
 * reaches those first.
 */
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { connect, type AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hydrateFromJson, type HydrateResult } from './hydrate.ts';
import { mintTestToken } from './fixtures/test-identity.ts';
import { createBridgeServer, type BridgeServerState } from './server.ts';
import { createSseHub, EVENT_STREAM_CONTENT_TYPE } from './events/sse.ts';
import { HEALTHY_RELOAD, summarizeSnapshotHealth } from './snapshot-health.ts';

const FIXTURE_URL = new URL('./fixtures/synthetic-snapshot.json', import.meta.url);
let TOKEN = '';

let hydrated: HydrateResult;
let server: ReturnType<typeof createBridgeServer>;
let baseUrl: string;
const hub = createSseHub();

beforeAll(async () => {
  hydrated = await hydrateFromJson(await readFile(fileURLToPath(FIXTURE_URL), 'utf8'));
  TOKEN = await mintTestToken(hydrated.driver);
  const state: BridgeServerState = {
    driver: hydrated.driver,
    snapshotGeneratedAt: new Date(hydrated.snapshot.generatedAt).toISOString(),
  };
  // The reload-health accessor is wired so the staleness header — set progressively, *before* the
  // handler writes anything — rides every response here; see the header-survival test below.
  server = createBridgeServer({
    getState: () => state,
    getSnapshotHealth: () => summarizeSnapshotHealth(HEALTHY_RELOAD),
    events: hub,
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  hub.close();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await hydrated.driver.close();
});

/** Request `path` with the valid bearer token, plus any extra headers the caller wants merged in. */
function request(path: string, method: string, extraHeaders: Record<string, string> = {}): Promise<Response> {
  return fetch(`${baseUrl}${path}`, {
    method,
    headers: { authorization: `Bearer ${TOKEN}`, ...extraHeaders },
  });
}

/**
 * Fetch `path` both ways and assert the HEAD matched the GET: same status, same content type, a
 * `Content-Length` equal to the GET body's byte length, and no body at all.
 */
async function expectHeadMatchesGet(path: string): Promise<Response> {
  const got = await request(path, 'GET');
  const body = await got.text();
  const head = await request(path, 'HEAD');

  expect(head.status).toBe(got.status);
  expect(head.headers.get('content-type')).toBe(got.headers.get('content-type'));
  expect(head.headers.get('cache-control')).toBe(got.headers.get('cache-control'));
  expect(head.headers.get('content-length')).toBe(String(Buffer.byteLength(body, 'utf8')));
  await expect(head.text()).resolves.toBe('');
  return head;
}

/**
 * Send a hand-written request line + headers and return the whole response as it arrived on the
 * wire. `Connection: close` and the bearer token are appended, so the read ends with the response.
 */
function rawRequest(port: number, head: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = connect(port, '127.0.0.1', () => {
      socket.write(`${head}authorization: Bearer ${TOKEN}\r\nconnection: close\r\n\r\n`);
    });
    const chunks: Buffer[] = [];
    socket.on('data', (chunk: Buffer) => chunks.push(chunk));
    socket.on('error', reject);
    socket.on('end', () => resolve(Buffer.concat(chunks).toString('latin1')));
  });
}

describe('HEAD on the read surfaces (issue #360)', () => {
  it('answers the legacy paths exactly as GET does, minus the content', async () => {
    for (const path of ['/health', '/search?q=ESP32', '/where?q=ESP32', '/metrics']) {
      await expectHeadMatchesGet(path);
    }
  });

  it('answers the versioned reads exactly as GET does, minus the content', async () => {
    for (const path of ['/api/v1', '/api/v1/openapi.json', '/api/v1/items', '/api/v1/items.csv']) {
      await expectHeadMatchesGet(path);
    }
  });

  // The motivating client: Outlook and several CalDAV/webcal subscribers HEAD the `.ics` URL to
  // test reachability (and to detect a change) before they will accept a subscription. They
  // subscribe by URL, so they send no `Authorization` header — the probe has to work on the
  // `?token=` form alone.
  it('answers the calendar feed for a header-less, token-in-URL subscriber', async () => {
    const url = `${baseUrl}/api/v1/calendar.ics?token=${TOKEN}`;
    const got = await fetch(url);
    const body = await got.text();
    const head = await fetch(url, { method: 'HEAD' });

    expect(head.status).toBe(200);
    expect(head.headers.get('content-type')).toContain('text/calendar');
    expect(head.headers.get('content-disposition')).toBe(got.headers.get('content-disposition'));
    expect(head.headers.get('content-length')).toBe(String(Buffer.byteLength(body, 'utf8')));
    await expect(head.text()).resolves.toBe('');
  });

  it('answers the syndication feeds a reader probes', async () => {
    for (const path of ['/api/v1/activity.rss', '/api/v1/activity.atom', '/api/v1/activity.json']) {
      await expectHeadMatchesGet(path);
    }
  });

  it('keeps the guards bodyless and identical to GET', async () => {
    // Unknown path, and an unauthenticated probe — both reached before any handler.
    await expectHeadMatchesGet('/nope');
    const unauth = await fetch(`${baseUrl}/search?q=ESP32`, { method: 'HEAD' });
    expect(unauth.status).toBe(401);
    expect(unauth.headers.get('www-authenticate')).toBe('Bearer');
    await expect(unauth.text()).resolves.toBe('');
  });

  // Holding the headers back until `end()` (the first moment the content length is known) must not
  // lose the ones set *before* the handler runs — the CORS grant and the staleness verdict are both
  // stamped that way, and a HEAD that dropped them would be unreadable to a cross-origin browser.
  it('keeps headers set before the handler ran', async () => {
    const res = await request('/search?q=ESP32', 'HEAD', { origin: 'http://localhost:5173' });
    expect(res.status).toBe(200);
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
    expect(res.headers.get('x-gubbins-snapshot-stale')).toBe('false');
    expect(res.headers.get('access-control-expose-headers')).toContain('X-Gubbins-Snapshot-Stale');
  });

  it('still refuses a method that is neither, advertising HEAD in Allow', async () => {
    const res = await request('/search?q=ESP32', 'DELETE');
    expect(res.status).toBe(405);
    expect(res.headers.get('allow')).toBe('GET, HEAD, OPTIONS');
    expect((await res.json()).error).toBe('Method not allowed');
  });

  it('advertises HEAD to a CORS preflight', async () => {
    const res = await request('/search', 'OPTIONS', { origin: 'http://localhost:5173' });
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-methods')).toBe('GET, HEAD, OPTIONS');
  });

  // `fetch` hides the framing, and the framing is what a strict client trips over: a declared
  // `Content-Length` with no body must not come with a chunked encoding, and not one byte may
  // follow the header block or the next response on a kept-alive connection is corrupt.
  it('puts nothing after the header block on the wire', async () => {
    const { port } = server.address() as AddressInfo;
    const raw = await rawRequest(port, `HEAD /health HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\n`);

    expect(raw).toMatch(/^HTTP\/1\.1 200 OK\r\n/);
    expect(raw).toMatch(/\r\ncontent-length: \d+\r\n/i);
    expect(raw).not.toMatch(/transfer-encoding/i);
    // The header block terminator is the *end* of the response — nothing trails it.
    expect(raw.indexOf('\r\n\r\n')).toBe(raw.length - 4);
  });

  // A HEAD of the SSE endpoint must report the stream's headers without opening one — otherwise a
  // probe would register a client and hold the response open until the request timeout.
  it('probes the event stream without opening it', async () => {
    const res = await request('/api/v1/events', 'HEAD');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe(EVENT_STREAM_CONTENT_TYPE);
    // Unbounded content: a length would be a guess, so none is sent.
    expect(res.headers.get('content-length')).toBeNull();
    await expect(res.text()).resolves.toBe('');
    expect(hub.clientCount()).toBe(0);
  });
});
