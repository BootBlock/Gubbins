/**
 * End-to-end A2 tests: the read-triggered `lookup.resolved` event through the real bridge HTTP
 * server, over the SYNTHETIC fixture (invented parts and locations, no real or personal data).
 *
 * The point of these is the *posture*: with the capability not wired — which is what
 * `GUBBINS_BRIDGE_LOOKUP_EVENTS` unset produces, including when `GUBBINS_BRIDGE_EVENTS=on` has
 * lit up the rest of the event machinery — a lookup must publish **nothing at all**.
 */
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hydrateFromJson, type HydrateResult } from '../hydrate.ts';
import { createBridgeServer, type BridgeServerState } from '../server.ts';
import { createSseHub } from './sse.ts';
import { createLookupObserver, type LookupEvent } from './lookup.ts';
import type { LookupObserver } from '../query.ts';

const FIXTURE_URL = new URL('../fixtures/synthetic-snapshot.json', import.meta.url);
const TOKEN = 'placeholder-token-for-tests';

let hydrated: HydrateResult;
let state: BridgeServerState;

beforeAll(async () => {
  hydrated = await hydrateFromJson(await readFile(fileURLToPath(FIXTURE_URL), 'utf8'));
  state = { driver: hydrated.driver, snapshotGeneratedAt: null };
});

afterAll(async () => {
  await hydrated.driver.close();
});

async function startServer(lookup?: LookupObserver) {
  const server = createBridgeServer({
    token: TOKEN,
    getState: () => state,
    // The SSE capability is deliberately ON here: it is the "GUBBINS_BRIDGE_EVENTS=on" posture,
    // and lookup events must still be absent unless their own observer is wired.
    events: createSseHub({ heartbeatMs: 0 }),
    lookup,
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    async stop() {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

function get(baseUrl: string, path: string): Promise<Response> {
  return fetch(`${baseUrl}${path}`, { headers: { authorization: `Bearer ${TOKEN}` } });
}

describe('lookup.resolved — default off', () => {
  it('emits nothing for /where or /api/v1/where when no observer is wired', async () => {
    const events: LookupEvent[] = [];
    // No `lookup` passed — exactly what an unset GUBBINS_BRIDGE_LOOKUP_EVENTS produces, even with
    // the event stream itself enabled above.
    const { baseUrl, stop } = await startServer();
    try {
      expect((await get(baseUrl, '/where?q=ESP32')).status).toBe(200);
      expect((await get(baseUrl, '/api/v1/where?q=ESP32')).status).toBe(200);
      expect(events).toEqual([]);
    } finally {
      await stop();
    }
  });
});

describe('lookup.resolved — wired', () => {
  it('publishes one event per resolved lookup on both where paths', async () => {
    const events: LookupEvent[] = [];
    const observer = createLookupObserver({
      deliver: (e) => void events.push(e),
      debounceMs: 0, // debounce is unit-tested; here we only care that the wiring fires.
    });
    const { baseUrl, stop } = await startServer(observer);
    try {
      await get(baseUrl, '/where?q=ESP32');
      await get(baseUrl, '/api/v1/where?q=ESP32');

      expect(events).toHaveLength(2);
      for (const event of events) {
        expect(event.type).toBe('lookup.resolved');
        expect(event.id).toMatch(/^lookup:[0-9a-f]{16}:\d+$/);
        expect(event.data.query).toBe('ESP32');
        expect(event.data.itemIds).toEqual(['item-esp32']);
        // The whole point of A2: resolved location IDS, not just names.
        expect([...event.data.locationIds].sort()).toEqual(['loc-bin-4', 'loc-shelf-2']);
        expect(event.data.matches[0]!.itemName).toBe('ESP32 Dev Board');
      }
    } finally {
      await stop();
    }
  });

  it('debounces a retried lookup down to one event', async () => {
    const events: LookupEvent[] = [];
    const observer = createLookupObserver({
      deliver: (e) => void events.push(e),
      debounceMs: 60_000, // far longer than the test runs, so every repeat is inside the window
    });
    const { baseUrl, stop } = await startServer(observer);
    try {
      await get(baseUrl, '/where?q=ESP32');
      await get(baseUrl, '/where?q=ESP32');
      await get(baseUrl, '/where?q=esp32'); // a rephrase that normalises identically
      expect(events).toHaveLength(1);

      // A genuinely different question is not suppressed.
      await get(baseUrl, '/where?q=M3');
      expect(events).toHaveLength(2);
      expect(events[1]!.data.query).toBe('M3');
    } finally {
      await stop();
    }
  });

  it('answers the lookup identically whether or not an observer is wired', async () => {
    const withNone = await startServer();
    const withObserver = await startServer(createLookupObserver({ deliver: () => {}, debounceMs: 0 }));
    try {
      const a = await (await get(withNone.baseUrl, '/api/v1/where?q=ESP32')).json();
      const b = await (await get(withObserver.baseUrl, '/api/v1/where?q=ESP32')).json();
      expect(b).toEqual(a);
    } finally {
      await withNone.stop();
      await withObserver.stop();
    }
  });
});
