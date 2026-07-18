/**
 * Home Assistant REST client (issue #122) — driven entirely through an injected `fetch`, so no
 * test touches the network.
 *
 * The assertions that matter most are the *negative* ones: that a Home Assistant failure never
 * leaks its own error text or the access token onward to the PWA.
 */
import { describe, expect, it, vi } from 'vitest';
import { createHaClient, HaError, normaliseHaBaseUrl, type FetchLike } from './client.ts';

/** A `fetch` stand-in returning a canned response, recording the calls it received. */
function fakeFetch(response: { ok?: boolean; status?: number; json?: () => Promise<unknown> }) {
  const calls: { url: string; init: { method: string; headers: Record<string, string> } }[] = [];
  const impl: FetchLike = async (url, init) => {
    calls.push({ url, init });
    return {
      ok: response.ok ?? true,
      status: response.status ?? 200,
      json: response.json ?? (async () => []),
    };
  };
  return { impl, calls };
}

const TOKEN = '<placeholder-ha-token>';

describe('normaliseHaBaseUrl', () => {
  it('strips trailing slashes and surrounding whitespace', () => {
    expect(normaliseHaBaseUrl('  http://ha.test:8123///  ')).toBe('http://ha.test:8123');
    expect(normaliseHaBaseUrl('http://ha.test:8123')).toBe('http://ha.test:8123');
  });
});

describe('createHaClient', () => {
  it('lists scale entities from GET /api/states with a bearer token', async () => {
    const { impl, calls } = fakeFetch({
      json: async () => [
        {
          entity_id: 'sensor.bench_scale',
          state: '812',
          attributes: { unit_of_measurement: 'g', friendly_name: 'Bench scale' },
        },
        { entity_id: 'light.hall', state: 'on', attributes: {} },
      ],
    });
    const client = createHaClient({ baseUrl: 'http://ha.test:8123/', token: TOKEN, fetchImpl: impl });

    await expect(client.listScaleEntities()).resolves.toEqual([
      { entityId: 'sensor.bench_scale', name: 'Bench scale', unit: 'g' },
    ]);
    expect(calls[0]!.url).toBe('http://ha.test:8123/api/states');
    expect(calls[0]!.init.headers.authorization).toBe(`Bearer ${TOKEN}`);
  });

  it('reads one entity, url-encoding the id', async () => {
    const { impl, calls } = fakeFetch({
      json: async () => ({
        entity_id: 'sensor.bench_scale',
        state: '2',
        attributes: { unit_of_measurement: 'kg' },
        last_updated: '2026-07-18T09:00:00.000Z',
      }),
    });
    const client = createHaClient({ baseUrl: 'http://ha.test:8123', token: TOKEN, fetchImpl: impl });

    await expect(client.readScale('sensor.bench_scale')).resolves.toMatchObject({
      ok: true,
      reading: { grams: 2000, value: 2, unit: 'kg' },
    });
    expect(calls[0]!.url).toBe('http://ha.test:8123/api/states/sensor.bench_scale');
  });

  it('maps a rejected token to a generic 502 that never echoes the token', async () => {
    const { impl } = fakeFetch({ ok: false, status: 401 });
    const client = createHaClient({ baseUrl: 'http://ha.test:8123', token: TOKEN, fetchImpl: impl });

    const error = await client.listScaleEntities().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(HaError);
    expect(error).toMatchObject({ status: 502, code: 'home_assistant_unauthorised' });
    expect((error as HaError).message).not.toContain(TOKEN);
  });

  it('maps an unknown entity to a 404', async () => {
    const { impl } = fakeFetch({ ok: false, status: 404 });
    const client = createHaClient({ baseUrl: 'http://ha.test:8123', token: TOKEN, fetchImpl: impl });

    await expect(client.readScale('sensor.nope')).rejects.toMatchObject({ status: 404, code: 'not_found' });
  });

  it('maps an unreachable Home Assistant to a 502 without leaking the underlying error', async () => {
    const impl: FetchLike = async () => {
      throw new Error(`connect ECONNREFUSED http://ha.test:8123 with ${TOKEN}`);
    };
    const client = createHaClient({ baseUrl: 'http://ha.test:8123', token: TOKEN, fetchImpl: impl });

    const error = await client.listScaleEntities().catch((e: unknown) => e);
    expect(error).toMatchObject({ status: 502, code: 'home_assistant_unreachable' });
    expect((error as HaError).message).toBe('Could not reach Home Assistant.');
  });

  it('maps an unreadable body to a 502 rather than throwing a parse error', async () => {
    const { impl } = fakeFetch({
      json: async () => {
        throw new Error('not json');
      },
    });
    const client = createHaClient({ baseUrl: 'http://ha.test:8123', token: TOKEN, fetchImpl: impl });

    await expect(client.listScaleEntities()).rejects.toMatchObject({ code: 'home_assistant_error' });
  });

  it('aborts a request that outlives the timeout', async () => {
    vi.useFakeTimers();
    try {
      const impl: FetchLike = (_url, init) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => reject(new Error('aborted')));
        });
      const client = createHaClient({
        baseUrl: 'http://ha.test:8123',
        token: TOKEN,
        fetchImpl: impl,
        timeoutMs: 1_000,
      });

      const pending = client.listScaleEntities().catch((e: unknown) => e);
      await vi.advanceTimersByTimeAsync(1_100);
      expect(await pending).toMatchObject({ code: 'home_assistant_unreachable' });
    } finally {
      vi.useRealTimers();
    }
  });
});
