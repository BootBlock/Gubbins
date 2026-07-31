import { describe, expect, it, vi } from 'vitest';
import { fetchLookupValues, searchLookupCandidates } from './flow';
import { LookupRunner } from './runner';
import type { LookupProvider } from './types';

const provider: LookupProvider = {
  id: 'test-provider',
  hosts: ['data.example.com'],
  minIntervalMs: 0,
  sourceName: 'Example',
  sourceUrl: 'https://data.example.com',
  outputs: [{ key: 'title', type: 'TEXT', defaultTarget: 'builtin:name' }],
  canSearch: (query) => query.name.length > 0,
  buildSearchRequest: (query) => ({
    url: `https://data.example.com/search?q=${encodeURIComponent(query.name)}`,
    headers: {},
  }),
  parseSearchResponse: (body) =>
    body === 'nothing'
      ? { ok: false, failure: { code: 'NO_MATCHES' } }
      : { ok: true, value: [{ id: 'A1', label: body, description: null, year: null }] },
  // Only `A1` is an id this provider ever issues, so anything else yields no request at all.
  buildDetailRequest: (id) => (id === 'A1' ? { url: 'https://data.example.com/a1', headers: {} } : null),
  parseDetailResponse: (body) => ({ ok: true, value: { title: body } }),
};

function runnerReturning(body: string) {
  const impl = vi.fn(async () => new Response(body, { status: 200 })) as unknown as typeof fetch;
  return { runner: new LookupRunner({ fetchImpl: impl, wait: async () => {}, now: () => 0 }), impl };
}

describe('searchLookupCandidates', () => {
  it('fetches, then parses, returning the provider’s candidates', async () => {
    const { runner, impl } = runnerReturning('Blade Runner');
    const result = await searchLookupCandidates(provider, { name: 'Blade Runner', year: null }, runner);
    expect(result).toEqual({
      ok: true,
      value: [{ id: 'A1', label: 'Blade Runner', description: null, year: null }],
    });
    expect(impl).toHaveBeenCalledOnce();
  });

  it('returns the fetch failure without ever calling the parser', async () => {
    const impl = vi.fn(async () => new Response('nope', { status: 503 })) as unknown as typeof fetch;
    const runner = new LookupRunner({ fetchImpl: impl, wait: async () => {}, now: () => 0 });
    const parse = vi.spyOn(provider, 'parseSearchResponse');
    const result = await searchLookupCandidates(provider, { name: 'x', year: null }, runner);
    expect(result).toEqual({ ok: false, failure: { code: 'HTTP', status: 503 } });
    expect(parse).not.toHaveBeenCalled();
    parse.mockRestore();
  });

  it('surfaces a parse-level miss as the provider reported it', async () => {
    const { runner } = runnerReturning('nothing');
    expect(await searchLookupCandidates(provider, { name: 'x', year: null }, runner)).toEqual({
      ok: false,
      failure: { code: 'NO_MATCHES' },
    });
  });
});

describe('fetchLookupValues', () => {
  it('fetches the chosen candidate’s detail and parses it', async () => {
    const { runner } = runnerReturning('Blade Runner');
    expect(await fetchLookupValues(provider, 'A1', runner)).toEqual({
      ok: true,
      value: { title: 'Blade Runner' },
    });
  });

  it('never fetches for a candidate id the provider will not build a request for', async () => {
    const { runner, impl } = runnerReturning('x');
    expect(await fetchLookupValues(provider, 'not-mine', runner)).toEqual({
      ok: false,
      failure: { code: 'NOT_FOUND' },
    });
    expect(impl).not.toHaveBeenCalled();
  });
});

describe('the flow offers no way to skip the user’s choice', () => {
  it('exposes search and detail as two separate steps keyed by a candidate id', async () => {
    // Structural, not behavioural: there is deliberately no "search and apply" helper, because
    // the first hit for "Blade Runner" on Wikidata is Philip K. Dick's novel. The only way to
    // reach values is to pass a candidate id, which only the picker produces.
    const module = await import('./flow');
    expect(Object.keys(module).sort()).toEqual(['fetchLookupValues', 'searchLookupCandidates']);
  });
});

describe('the extension fetch path', () => {
  it('runs the whole flow through a caller-supplied fetcher, never touching fetch', async () => {
    const impl = vi.fn(async () => new Response('direct', { status: 200 })) as unknown as typeof fetch;
    const runner = new LookupRunner({ fetchImpl: impl, wait: async () => {}, now: () => 0 });
    const fetcher = vi.fn(async () => ({ ok: true as const, value: 'via extension' }));

    const search = await searchLookupCandidates(provider, { name: 'x', year: null }, runner, fetcher);
    expect(search).toMatchObject({ ok: true, value: [{ label: 'via extension' }] });
    const detail = await fetchLookupValues(provider, 'A1', runner, fetcher);
    expect(detail).toEqual({ ok: true, value: { title: 'via extension' } });
    expect(impl).not.toHaveBeenCalled();
  });
});
