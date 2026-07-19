import { describe, it, expect, vi } from 'vitest';
import { checkBridgeBuild, readBridgeBuild, API_INDEX_PATH } from './bridge-build-check';

/** A `fetch` stand-in that answers once with the given status and JSON body. */
function respondWith(status: number, body: unknown) {
  return vi.fn(async () => ({ status, json: async () => body }));
}

const INDEX = { name: 'Gubbins Bridge API', bridge: { version: '1.0.0', schemaVersion: 2 } };

describe('readBridgeBuild', () => {
  it('reads a well-formed bridge block', () => {
    expect(readBridgeBuild(INDEX)).toEqual({ version: '1.0.0', schemaVersion: 2 });
  });

  it('returns null for a bridge old enough to have no block at all', () => {
    expect(readBridgeBuild({ name: 'Gubbins Bridge API', version: '1.0.0' })).toBeNull();
  });

  it.each([
    ['a non-object payload', 'nope'],
    ['a null payload', null],
    ['a missing version', { bridge: { schemaVersion: 2 } }],
    ['a blank version', { bridge: { version: '  ', schemaVersion: 2 } }],
    ['a non-string version', { bridge: { version: 3, schemaVersion: 2 } }],
    ['a missing schemaVersion', { bridge: { version: '1.0.0' } }],
    ['a non-integer schemaVersion', { bridge: { version: '1.0.0', schemaVersion: 2.5 } }],
  ])('refuses to half-read %s', (_label, payload) => {
    expect(readBridgeBuild(payload)).toBeNull();
  });
});

describe('checkBridgeBuild', () => {
  it('appends the index path to the configured base URL and sends the bearer token', async () => {
    const fetchImpl = respondWith(200, INDEX);
    await checkBridgeBuild('http://bridge.test:8787/', 'tok', fetchImpl);

    expect(fetchImpl).toHaveBeenCalledWith(`http://bridge.test:8787${API_INDEX_PATH}`, {
      method: 'GET',
      headers: { authorization: 'Bearer tok' },
    });
  });

  it('does not double up the path when the user pasted the full index URL', async () => {
    const fetchImpl = respondWith(200, INDEX);
    await checkBridgeBuild('http://bridge.test:8787/api/v1', 'tok', fetchImpl);

    expect(fetchImpl).toHaveBeenCalledWith(`http://bridge.test:8787${API_INDEX_PATH}`, expect.anything());
  });

  it('compares what the bridge reported against this app', async () => {
    const result = await checkBridgeBuild('http://bridge.test', 'tok', respondWith(200, INDEX));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.bridge).toEqual({ version: '1.0.0', schemaVersion: 2 });
    // The fixture is deliberately far behind whatever the app currently is.
    expect(result.status).toBe('schema-behind');
  });

  it('reports `unknown` when a reachable bridge answers without a build block', async () => {
    // It answered fine — it is just old enough to predate reporting its version, which is
    // itself the thing worth telling the user, so this is a verdict rather than a failure.
    const old = { name: 'Gubbins Bridge API', version: '1.0.0', endpoints: [] };
    const result = await checkBridgeBuild('http://bridge.test', 'tok', respondWith(200, old));

    expect(result).toMatchObject({ ok: true, status: 'unknown', bridge: null });
  });

  it('has no opinion when a 200 comes from something that is not a bridge at all', async () => {
    // Pointing the URL at an unrelated server that answers 200 must not be reported as "your
    // bridge is out of date" — that sends the user off updating something blameless.
    const result = await checkBridgeBuild(
      'http://bridge.test',
      'tok',
      respondWith(200, { message: 'welcome to nginx' }),
    );

    expect(result).toEqual({ ok: false });
  });

  it.each([401, 404, 500])('has no opinion when the bridge answers %i', async (status) => {
    expect(await checkBridgeBuild('http://bridge.test', 'tok', respondWith(status, {}))).toEqual({
      ok: false,
    });
  });

  it('has no opinion when the bridge is unreachable, and never surfaces the raw error', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('ECONNREFUSED 10.0.0.5');
    });
    expect(await checkBridgeBuild('http://bridge.test', 'tok', fetchImpl)).toEqual({ ok: false });
  });

  it('has no opinion when the body is not JSON at all', async () => {
    const fetchImpl = vi.fn(async () => ({
      status: 200,
      json: async () => {
        throw new Error('not json');
      },
    }));
    expect(await checkBridgeBuild('http://bridge.test', 'tok', fetchImpl)).toEqual({ ok: false });
  });

  it.each([
    ['a blank URL', '', 'tok'],
    ['a non-HTTP URL', 'ftp://bridge.test', 'tok'],
    ['a blank token', 'http://bridge.test', '   '],
  ])('never reaches the network for %s', async (_label, url, token) => {
    const fetchImpl = vi.fn();
    expect(await checkBridgeBuild(url, token, fetchImpl)).toEqual({ ok: false });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
