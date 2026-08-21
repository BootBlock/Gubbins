/**
 * `GET /api/v1/scale/stream` hub tests (issue #125, phase 1).
 *
 * The hub is driven through a real `node:http` server so the long-lived response, the client
 * teardown on disconnect and the poll loop's lifetime are all exercised as they actually run;
 * only Home Assistant itself is faked, via the injected `readScale`.
 */
import { createServer, type Server } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { HaError } from './client.ts';
import type { ScaleReadingOutcome } from './scale.ts';
import {
  createScaleStreamHub,
  SCALE_STREAM_CONTENT_TYPE,
  type ScaleStreamFrame,
  type ScaleStreamHub,
} from './scale-stream.ts';

const READING: ScaleReadingOutcome = {
  ok: true,
  reading: { entityId: 'sensor.bench_scale', grams: 1250, value: 1.25, unit: 'kg', lastUpdated: null },
};

let server: Server | undefined;
let hub: ScaleStreamHub | undefined;
/** Every stream opened by a test, aborted in teardown so no socket outlives its case. */
let openStreams: AbortController[] = [];

afterEach(async () => {
  for (const controller of openStreams) controller.abort();
  openStreams = [];
  hub?.close();
  hub = undefined;
  if (server) {
    const closing = server;
    server = undefined;
    await new Promise<void>((resolve) => closing.close(() => resolve()));
  }
});

/** Start a server in front of a hub, and return a helper that opens a stream against it. */
async function start(
  readScale: (entityId: string) => Promise<ScaleReadingOutcome>,
  options: { pollMs?: number; maxClients?: number } = {},
) {
  hub = createScaleStreamHub({ readScale, heartbeatMs: 0, pollMs: 5, ...options });
  const live = hub;
  server = createServer((req, res) => {
    void live.handleConnection(req, res, new URL(req.url ?? '/', 'http://localhost'));
  });
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as { port: number };
  return async (query: string): Promise<{ res: Response; abort: () => void }> => {
    const controller = new AbortController();
    openStreams.push(controller);
    const res = await fetch(`http://127.0.0.1:${port}/api/v1/scale/stream${query}`, {
      signal: controller.signal,
    });
    return { res, abort: () => controller.abort() };
  };
}

/**
 * Read `count` `data:` frames off a live stream. Reads the body as a stream rather than awaiting
 * `res.text()`, which would never resolve: the response is unbounded by design.
 */
async function readFrames(res: Response, count: number): Promise<ScaleStreamFrame[]> {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  const frames: ScaleStreamFrame[] = [];
  let buffered = '';
  try {
    while (frames.length < count) {
      const { value, done } = await reader.read();
      if (done) break;
      buffered += decoder.decode(value, { stream: true });
      // Keep the trailing fragment: a chunk can split a frame anywhere, including mid-JSON.
      const lines = buffered.split('\n');
      buffered = lines.pop() ?? '';
      for (const line of lines) {
        if (line.startsWith('data: ')) frames.push(JSON.parse(line.slice(6)) as ScaleStreamFrame);
      }
    }
  } finally {
    reader.releaseLock();
  }
  // One read can deliver several frames, so trim to exactly what the caller asked for — otherwise
  // a test's expectations would depend on how the kernel happened to chunk the socket.
  return frames.slice(0, count);
}

/** Wait for a predicate to hold, so a test never races the hub's own teardown. */
async function until(predicate: () => boolean): Promise<void> {
  await vi.waitFor(() => {
    if (!predicate()) throw new Error('not yet');
  });
}

describe('scale stream', () => {
  it('requires an entity_id', async () => {
    const open = await start(async () => READING);
    const { res } = await open('');
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe('bad_request');
  });

  it('streams the first reading immediately, then keeps sampling', async () => {
    const open = await start(async () => READING);
    const { res } = await open('?entity_id=sensor.bench_scale');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe(SCALE_STREAM_CONTENT_TYPE);

    const frames = await readFrames(res, 3);
    expect(frames).toHaveLength(3);
    for (const frame of frames) {
      expect(frame).toEqual({ ok: true, reading: READING.reading });
    }
  });

  // The whole point of a live feed: the number the dialog shows has to change as parts land.
  it('reports each new sample, not just the first', async () => {
    let grams = 100;
    const open = await start(async () => {
      grams += 100;
      return { ok: true, reading: { ...READING.reading, grams, value: grams, unit: 'g' } };
    });
    const { res } = await open('?entity_id=sensor.bench_scale');
    const frames = await readFrames(res, 3);
    expect(frames.map((f) => (f.ok ? f.reading.grams : null))).toEqual([200, 300, 400]);
  });

  // A scale that is switched off is a genuine scale that cannot be read *right now* — the stream
  // stays open and says so, because it may well come back while the dialog is still open.
  it('opens the stream for an unavailable scale and reports it', async () => {
    const open = await start(async () => ({ ok: false, issue: 'unavailable' }));
    const { res } = await open('?entity_id=sensor.bench_scale');
    expect(res.status).toBe(200);
    expect(await readFrames(res, 2)).toEqual([
      { ok: false, issue: 'unavailable' },
      { ok: false, issue: 'unavailable' },
    ]);
  });

  // Issue #179: a non-scale entity must be indistinguishable from a missing one. The stream is
  // never opened, so it cannot become a read oracle over the rest of the user's home either.
  it('answers a non-scale entity as a plain 404, revealing nothing', async () => {
    const open = await start(async () => ({ ok: false, issue: 'not-a-scale' }));
    const { res } = await open('?entity_id=sensor.lounge_temperature');
    expect(res.status).toBe(404);
    expect((await res.json()).error).toEqual({ code: 'not_found', message: 'No such entity.' });
  });

  it('answers a thrown 404 identically to an inline non-scale outcome', async () => {
    const open = await start(async () => {
      throw new HaError(404, 'not_found', 'No such entity.');
    });
    const { res } = await open('?entity_id=sensor.nope');
    expect(res.status).toBe(404);
    expect((await res.json()).error.code).toBe('not_found');
  });

  it('answers a rejected token as the same 502 the one-shot read gives', async () => {
    const open = await start(async () => {
      throw new HaError(502, 'home_assistant_unauthorised', 'Home Assistant rejected the access token.');
    });
    const { res } = await open('?entity_id=sensor.bench_scale');
    expect(res.status).toBe(502);
    expect((await res.json()).error.code).toBe('home_assistant_unauthorised');
  });

  // An entity that vanishes mid-stream has nothing left to watch, so the stream ends rather than
  // repeating the same dead answer four times a second.
  it('ends the stream when the entity stops being a scale', async () => {
    let reads = 0;
    const open = await start(async () => {
      reads += 1;
      return reads === 1 ? READING : { ok: false, issue: 'not-a-scale' };
    });
    const { res } = await open('?entity_id=sensor.bench_scale');
    const text = await res.text(); // resolves because the hub ends the response
    expect(text).toContain('"issue":"gone"');
    await until(() => hub!.clientCount() === 0);
  });

  // A momentarily-unreachable Home Assistant is exactly what a live watch should ride out.
  it('keeps streaming through a transient upstream failure', async () => {
    let reads = 0;
    const open = await start(async () => {
      reads += 1;
      if (reads === 2) throw new HaError(502, 'home_assistant_error', 'Home Assistant returned an error.');
      return READING;
    });
    const { res } = await open('?entity_id=sensor.bench_scale');
    const frames = await readFrames(res, 3);
    expect(frames[1]).toEqual({ ok: false, issue: 'home-assistant-error' });
    expect(frames[2]).toEqual({ ok: true, reading: READING.reading });
  });

  it('carries no id: or retry: line, so a reconnect cannot replay a stale weight', async () => {
    const open = await start(async () => READING);
    const { res } = await open('?entity_id=sensor.bench_scale');
    const reader = res.body!.getReader();
    const chunk = new TextDecoder().decode((await reader.read()).value);
    reader.releaseLock();
    expect(chunk).not.toMatch(/^id:/m);
    expect(chunk).not.toMatch(/^retry:/m);
  });

  // Per-dialog lifetime: nothing keeps reading the user's scale once nobody is looking at it.
  it('stops polling once the last client disconnects', async () => {
    let reads = 0;
    const open = await start(async () => {
      reads += 1;
      return READING;
    });
    const { res, abort } = await open('?entity_id=sensor.bench_scale');
    await readFrames(res, 2);
    abort();
    await until(() => hub!.clientCount() === 0);
    const settled = reads;
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(reads).toBe(settled);
  });

  // One watch per entity, shared: dropping one client must not take the other's stream with it.
  it('keeps a shared entity streaming when one of its clients leaves', async () => {
    const open = await start(async () => READING);
    const first = await open('?entity_id=sensor.bench_scale');
    await readFrames(first.res, 1);
    const second = await open('?entity_id=sensor.bench_scale');
    // The joiner is served the gate read as its own first frame, so it never waits a poll
    // interval — and it joins the existing watch rather than starting a second one.
    expect(await readFrames(second.res, 1)).toEqual([{ ok: true, reading: READING.reading }]);
    await until(() => hub!.clientCount() === 2);

    first.abort();
    await until(() => hub!.clientCount() === 1);
    // Still live: the surviving client keeps receiving samples.
    expect(await readFrames(second.res, 2)).toHaveLength(2);
  });

  it('refuses a client beyond the concurrency cap', async () => {
    const open = await start(async () => READING, { maxClients: 1 });
    const first = await open('?entity_id=sensor.bench_scale');
    await readFrames(first.res, 1);
    const { res } = await open('?entity_id=sensor.other_scale');
    expect(res.status).toBe(429);
    expect(res.headers.get('retry-after')).toBe('30');
    await res.json();
  });

  it('closes every stream on shutdown', async () => {
    const open = await start(async () => READING);
    const { res } = await open('?entity_id=sensor.bench_scale');
    await readFrames(res, 1);
    expect(hub!.clientCount()).toBe(1);
    hub!.close();
    expect(hub!.clientCount()).toBe(0);
  });
});
