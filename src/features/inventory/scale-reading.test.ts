/**
 * Scale-reading transport (issue #122) — the PWA's bridge client, driven with a fake `fetch`.
 *
 * The recurring assertion is that **no failure path throws and none leaks the bridge token**:
 * this runs behind a button in a dialog, so an unhandled rejection would strand the user with a
 * spinner and no explanation.
 */
import { describe, expect, it } from 'vitest';
import {
  buildScaleRequest,
  fetchScaleEntities,
  fetchScaleReading,
  mapScaleFailure,
  type FetchLike,
} from './scale-reading';

const BASE_URL = 'http://127.0.0.1:8787';
const TOKEN = 'placeholder-bridge-token';

/** A `fetch` stand-in returning a canned status/body and recording the calls it saw. */
function fakeFetch(status: number, payload: unknown) {
  const calls: { url: string; headers: Record<string, string> }[] = [];
  const impl: FetchLike = async (url, init) => {
    calls.push({ url, headers: init.headers });
    return { status, json: async () => payload };
  };
  return { impl, calls };
}

/** A `fetch` that fails the way an offline bridge does. */
const offlineFetch: FetchLike = async () => {
  throw new TypeError('Failed to fetch');
};

describe('buildScaleRequest', () => {
  it('joins the base URL with the path and attaches the bearer token', () => {
    const request = buildScaleRequest('http://127.0.0.1:8787/', TOKEN, '/api/v1/scale/entities');
    expect(request.url).toBe('http://127.0.0.1:8787/api/v1/scale/entities');
    expect(request.headers.authorization).toBe(`Bearer ${TOKEN}`);
  });

  it('rejects a blank or non-HTTP url, and a blank token', () => {
    expect(() => buildScaleRequest('', TOKEN, '/x')).toThrow(/Enter the bridge URL/);
    expect(() => buildScaleRequest('ftp://nope', TOKEN, '/x')).toThrow(/http:\/\/ or https:\/\//);
    expect(() => buildScaleRequest(BASE_URL, '   ', '/x')).toThrow(/access token/);
  });
});

describe('fetchScaleEntities', () => {
  it('returns the weight sensors the bridge reports', async () => {
    const { impl, calls } = fakeFetch(200, {
      entities: [{ entityId: 'sensor.bench', name: 'Bench scale', unit: 'kg' }],
    });

    await expect(fetchScaleEntities({ baseUrl: BASE_URL, token: TOKEN, fetchImpl: impl })).resolves.toEqual({
      ok: true,
      entities: [{ entityId: 'sensor.bench', name: 'Bench scale', unit: 'kg' }],
    });
    expect(calls[0]!.url).toBe(`${BASE_URL}/api/v1/scale/entities`);
  });

  it('skips malformed entries rather than rendering a broken option', async () => {
    const { impl } = fakeFetch(200, { entities: [{ name: 'No id' }, { entityId: 'sensor.ok' }] });
    const result = await fetchScaleEntities({ baseUrl: BASE_URL, token: TOKEN, fetchImpl: impl });
    // A missing name falls back to the entity id, so the option is still selectable and labelled.
    expect(result).toEqual({ ok: true, entities: [{ entityId: 'sensor.ok', name: 'sensor.ok', unit: '' }] });
  });

  it('reports a bridge without the Home Assistant opt-in as "not enabled"', async () => {
    const { impl } = fakeFetch(404, { error: { code: 'not_found', message: 'Not found' } });
    const result = await fetchScaleEntities({ baseUrl: BASE_URL, token: TOKEN, fetchImpl: impl });
    expect(result).toEqual({ ok: false, failure: 'not-enabled' });
  });

  it('reports an offline bridge without throwing or echoing the token', async () => {
    const result = await fetchScaleEntities({ baseUrl: BASE_URL, token: TOKEN, fetchImpl: offlineFetch });
    expect(result).toEqual({ ok: false, failure: 'bridge-unreachable' });
    expect(JSON.stringify(result)).not.toContain(TOKEN);
  });
});

describe('fetchScaleReading', () => {
  it('returns the reading in canonical grams alongside the raw value', async () => {
    const { impl, calls } = fakeFetch(200, {
      entityId: 'sensor.bench',
      grams: 1250,
      value: 1.25,
      unit: 'kg',
    });

    await expect(
      fetchScaleReading({ baseUrl: BASE_URL, token: TOKEN, fetchImpl: impl }, 'sensor.bench'),
    ).resolves.toEqual({ ok: true, grams: 1250, value: 1.25, unit: 'kg' });
    expect(calls[0]!.url).toBe(`${BASE_URL}/api/v1/scale/state?entity_id=sensor.bench`);
  });

  it('url-encodes the entity id', async () => {
    const { impl, calls } = fakeFetch(200, { grams: 1, value: 1, unit: 'g' });
    await fetchScaleReading({ baseUrl: BASE_URL, token: TOKEN, fetchImpl: impl }, 'sensor.a b&c');
    expect(calls[0]!.url).toContain('entity_id=sensor.a%20b%26c');
  });

  it('refuses to call the bridge with no entity chosen', async () => {
    const { impl, calls } = fakeFetch(200, {});
    const result = await fetchScaleReading({ baseUrl: BASE_URL, token: TOKEN, fetchImpl: impl }, '  ');
    expect(result).toEqual({ ok: false, failure: 'no-entity' });
    expect(calls).toHaveLength(0);
  });

  // The bridge's CODE is the signal, not its (untranslatable) English prose.
  it('resolves an unusable reading from the bridge error code', async () => {
    const { impl } = fakeFetch(409, {
      error: { code: 'scale_unavailable', message: 'The scale is unavailable in Home Assistant.' },
    });
    const result = await fetchScaleReading(
      { baseUrl: BASE_URL, token: TOKEN, fetchImpl: impl },
      'sensor.bench',
    );
    expect(result).toEqual({ ok: false, failure: 'scale-unavailable' });
  });

  // The critical one: a payload missing `grams` must never be read as a zero weight, which would
  // count the stock down to nothing.
  it('rejects a response with no usable grams rather than defaulting to zero', async () => {
    const { impl } = fakeFetch(200, { entityId: 'sensor.bench', value: 1.25, unit: 'kg' });
    const result = await fetchScaleReading(
      { baseUrl: BASE_URL, token: TOKEN, fetchImpl: impl },
      'sensor.bench',
    );
    expect(result).toEqual({ ok: false, failure: 'bad-response' });
  });
});

describe('mapScaleFailure', () => {
  it('maps each status onto a distinct, translatable reason', () => {
    expect(mapScaleFailure(401, undefined)).toBe('unauthorised');
    expect(mapScaleFailure(404, undefined)).toBe('not-enabled');
    expect(mapScaleFailure(429, undefined)).toBe('rate-limited');
    expect(mapScaleFailure(502, undefined)).toBe('home-assistant-unreachable');
  });

  // Three different 409s need three different explanations, told apart by CODE not prose.
  it('distinguishes the 409 reasons by the bridge error code', () => {
    const at = (code: string) => mapScaleFailure(409, { error: { code, message: 'ignored' } });
    expect(at('scale_unavailable')).toBe('scale-unavailable');
    expect(at('scale_unsupported_unit')).toBe('unsupported-unit');
    expect(at('scale_not_a_number')).toBe('not-a-number');
    // An unrecognised 409 still lands on a sensible, specific-enough reason.
    expect(at('scale_something_new')).toBe('scale-unavailable');
  });
});
