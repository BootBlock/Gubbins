/**
 * Home Assistant REST client (issue #122) — driven entirely through an injected `fetch`, so no
 * test touches the network.
 *
 * The assertions that matter most are the *negative* ones: that a Home Assistant failure never
 * leaks its own error text or the access token onward to the PWA.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  createHaClient,
  haRetryPlan,
  HA_MAX_ATTEMPTS,
  HA_REQUEST_TIMEOUT_MS,
  HaError,
  normaliseHaBaseUrl,
  type FetchLike,
} from './client.ts';

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

  // Issue #179: a read of an entity that isn't a scale is answered exactly like a missing one —
  // the same 404, the same message — so a token holder can't probe the rest of the user's home.
  it('answers a non-scale entity as a 404, identical to a missing one', async () => {
    const nonScale = fakeFetch({
      json: async () => ({
        entity_id: 'sensor.lounge_temperature',
        state: '21.5',
        attributes: { unit_of_measurement: '°C', friendly_name: 'Lounge temperature' },
        last_updated: '2026-07-18T09:00:00.000Z',
      }),
    });
    const nonScaleClient = createHaClient({
      baseUrl: 'http://ha.test:8123',
      token: TOKEN,
      fetchImpl: nonScale.impl,
    });
    const nonScaleError = await nonScaleClient
      .readScale('sensor.lounge_temperature')
      .catch((e: unknown) => e);

    const missing = fakeFetch({ ok: false, status: 404 });
    const missingClient = createHaClient({
      baseUrl: 'http://ha.test:8123',
      token: TOKEN,
      fetchImpl: missing.impl,
    });
    const missingError = await missingClient.readScale('sensor.nope').catch((e: unknown) => e);

    expect(nonScaleError).toBeInstanceOf(HaError);
    // Same status, code and message as a genuinely-unknown entity — no oracle.
    expect(nonScaleError).toMatchObject({ status: 404, code: 'not_found' });
    expect((nonScaleError as HaError).status).toBe((missingError as HaError).status);
    expect((nonScaleError as HaError).code).toBe((missingError as HaError).code);
    expect((nonScaleError as HaError).message).toBe((missingError as HaError).message);
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

  it('aborts a request that outlives the timeout, after exhausting its attempts', async () => {
    vi.useFakeTimers();
    try {
      let attempts = 0;
      const impl: FetchLike = (_url, init) => {
        attempts += 1;
        return new Promise((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => reject(new Error('aborted')));
        });
      };
      const client = createHaClient({
        baseUrl: 'http://ha.test:8123',
        token: TOKEN,
        fetchImpl: impl,
        timeoutMs: 1_000,
      });

      const pending = client.listScaleEntities().catch((e: unknown) => e);
      await vi.advanceTimersByTimeAsync(1_100);
      expect(await pending).toMatchObject({ code: 'home_assistant_unreachable' });
      // The whole budget bought both attempts — it was not spent twice over.
      expect(attempts).toBe(HA_MAX_ATTEMPTS);
    } finally {
      vi.useRealTimers();
    }
  });

  it('probes with the same list-states read, discarding the payload', async () => {
    const { impl, calls } = fakeFetch({ json: async () => [] });
    const client = createHaClient({ baseUrl: 'http://ha.test:8123', token: TOKEN, fetchImpl: impl });

    await expect(client.probe()).resolves.toBeUndefined();
    expect(calls.map((c) => c.url)).toEqual(['http://ha.test:8123/api/states']);
  });

  it('surfaces a rejected token from the probe, so startup can say which failure it was', async () => {
    const { impl } = fakeFetch({ ok: false, status: 401 });
    const client = createHaClient({ baseUrl: 'http://ha.test:8123', token: TOKEN, fetchImpl: impl });

    await expect(client.probe()).rejects.toMatchObject({ code: 'home_assistant_unauthorised' });
  });
});

/**
 * Retry policy. The point of these is the *budget*: a momentarily-busy Home Assistant gets a second
 * chance, but a genuinely-down one must not take noticeably longer to report than it used to, and a
 * deterministic refusal (a bad token, an unknown entity) must not be asked twice at all.
 */
describe('createHaClient retry budget', () => {
  it('fits every attempt and backoff inside the total request budget', () => {
    const plan = haRetryPlan();
    const total = plan.attemptTimeoutMs * plan.attempts + plan.backoffMs * (plan.attempts - 1);
    expect(total).toBeLessThanOrEqual(HA_REQUEST_TIMEOUT_MS);
    expect(plan.attempts).toBe(HA_MAX_ATTEMPTS);
    expect(HA_MAX_ATTEMPTS).toBeGreaterThan(1);
  });

  it('spends a budget too small to retry within on a single attempt', () => {
    // Retrying inside a 100 ms budget would cost 200 ms of backoff alone — it would overrun the
    // very budget the caller asked for, and buy two attempts too short to succeed.
    const plan = haRetryPlan(100);
    expect(plan.attempts).toBe(1);
    expect(plan.attemptTimeoutMs).toBe(100);
    expect(plan.attemptTimeoutMs * plan.attempts + plan.backoffMs * (plan.attempts - 1)).toBeLessThanOrEqual(
      100,
    );
  });

  /** A `fetch` stand-in that plays a scripted sequence of outcomes, one per attempt. */
  function scriptedFetch(steps: readonly (Error | { ok?: boolean; status?: number })[]) {
    let n = 0;
    const impl: FetchLike = async () => {
      const step = steps[Math.min(n, steps.length - 1)]!;
      n += 1;
      if (step instanceof Error) throw step;
      return { ok: step.ok ?? true, status: step.status ?? 200, json: async () => [] };
    };
    return { impl, attempts: () => n };
  }

  /** Run `body` with fake timers, so the fixed backoff costs no real wall time. */
  async function withFakeTimers<T>(body: () => Promise<T>): Promise<T> {
    vi.useFakeTimers();
    try {
      const pending = body();
      await vi.advanceTimersByTimeAsync(HA_REQUEST_TIMEOUT_MS);
      return await pending;
    } finally {
      vi.useRealTimers();
    }
  }

  it('retries a transport failure once and succeeds on the second attempt', async () => {
    const { impl, attempts } = scriptedFetch([new Error('ECONNRESET'), {}]);
    const client = createHaClient({ baseUrl: 'http://ha.test:8123', token: TOKEN, fetchImpl: impl });

    await expect(withFakeTimers(() => client.listScaleEntities())).resolves.toEqual([]);
    expect(attempts()).toBe(2);
  });

  it('retries a 5xx — Home Assistant itself struggling is exactly the transient case', async () => {
    const { impl, attempts } = scriptedFetch([{ ok: false, status: 503 }, {}]);
    const client = createHaClient({ baseUrl: 'http://ha.test:8123', token: TOKEN, fetchImpl: impl });

    await expect(withFakeTimers(() => client.listScaleEntities())).resolves.toEqual([]);
    expect(attempts()).toBe(2);
  });

  it('gives up after the attempt limit rather than retrying indefinitely', async () => {
    const { impl, attempts } = scriptedFetch([new Error('ECONNREFUSED')]);
    const client = createHaClient({ baseUrl: 'http://ha.test:8123', token: TOKEN, fetchImpl: impl });

    await expect(
      withFakeTimers(() => client.listScaleEntities().catch((e: unknown) => e)),
    ).resolves.toMatchObject({ code: 'home_assistant_unreachable' });
    expect(attempts()).toBe(HA_MAX_ATTEMPTS);
  });

  it.each([
    ['a rejected token', 401, 'home_assistant_unauthorised'],
    ['a forbidden token', 403, 'home_assistant_unauthorised'],
    ['an unknown entity', 404, 'not_found'],
    ['a malformed request', 400, 'home_assistant_error'],
  ])('never retries %s — the answer is deterministic', async (_label, status, code) => {
    const { impl, attempts } = scriptedFetch([{ ok: false, status }]);
    const client = createHaClient({ baseUrl: 'http://ha.test:8123', token: TOKEN, fetchImpl: impl });

    await expect(
      withFakeTimers(() => client.readScale('sensor.x').catch((e: unknown) => e)),
    ).resolves.toMatchObject({ code });
    expect(attempts()).toBe(1);
  });
});
