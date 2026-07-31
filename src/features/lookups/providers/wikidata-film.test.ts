/**
 * The `wikidata-film` provider, driven against **captured** response bodies.
 *
 * The bodies below are trimmed copies of real answers from the live endpoints (the Blade Runner
 * ones are the exact case the design research turned up), so the parsers are tested against the
 * shape the source actually returns without a network call in the test.
 */
import { describe, expect, it } from 'vitest';
import { WIKIDATA_API_HOST, WIKIDATA_FILM_PROVIDER, WIKIDATA_SPARQL_HOST } from './wikidata-film';

const provider = WIKIDATA_FILM_PROVIDER;

/**
 * A trimmed `wbsearchentities` answer for "Blade Runner" — **in the order the API returns it**.
 * The novel is genuinely first, because "Blade Runner" is a registered alias of it; the film is
 * fourth. This ordering is the whole reason the match picker is mandatory.
 */
const SEARCH_BODY = JSON.stringify({
  searchinfo: { search: 'Blade Runner' },
  search: [
    {
      id: 'Q605249',
      label: 'Do Androids Dream of Electric Sheep?',
      description: 'science fiction novel by Philip K. Dick',
    },
    { id: 'Q881018', label: 'Blade Runner', description: '1997 video game' },
    { id: 'Q4923701', label: 'Blade Runner', description: '1985 video game' },
    { id: 'Q184843', label: 'Blade Runner', description: '1982 film by Ridley Scott' },
  ],
});

const literal = (value: string) => ({ type: 'literal', value });

const DETAIL_BODY = JSON.stringify({
  head: { vars: ['title', 'imdbId', 'year', 'runtime', 'directors', 'genres', 'studios', 'cast'] },
  results: {
    bindings: [
      {
        title: { 'xml:lang': 'en', ...literal('Blade Runner') },
        imdbId: literal('tt0083658'),
        year: { datatype: 'http://www.w3.org/2001/XMLSchema#integer', ...literal('1982') },
        runtime: { datatype: 'http://www.w3.org/2001/XMLSchema#decimal', ...literal('112') },
        directors: literal('Ridley Scott'),
        genres: literal('science fiction film, film noir, cyberpunk'),
        studios: literal('The Ladd Company, Warner Bros. Entertainment'),
        cast: literal('Harrison Ford, Rutger Hauer, Sean Young'),
      },
    ],
  },
});

describe('wikidata-film — the descriptor', () => {
  it('declares only the two hosts it reaches', () => {
    expect(provider.hosts).toEqual([WIKIDATA_API_HOST, WIKIDATA_SPARQL_HOST]);
  });

  it('names its source honestly — Wikidata, not IMDb', () => {
    // The IMDb *link* is among the values, but the data came from an open database. Saying
    // otherwise would misdescribe where a value on the user's item originated.
    expect(provider.sourceName).toBe('Wikidata');
    expect(provider.sourceUrl).not.toContain('imdb');
  });

  it('asks for a gap between requests, because the source does', () => {
    expect(provider.minIntervalMs).toBeGreaterThanOrEqual(1000);
  });

  it('offers no lookup for an unnamed item', () => {
    expect(provider.canSearch({ name: '', year: null })).toBe(false);
    expect(provider.canSearch({ name: '   ', year: 1982 })).toBe(false);
    expect(provider.canSearch({ name: 'Blade Runner', year: null })).toBe(true);
  });

  it('binds its year key to one of its own outputs', () => {
    expect(provider.outputs.map((o) => o.key)).toContain(provider.yearOutputKey);
  });
});

describe('wikidata-film — the search request', () => {
  it('targets the Action API with a cross-origin-capable entity search', () => {
    const request = provider.buildSearchRequest({ name: 'Blade Runner', year: null });
    const url = new URL(request.url);
    expect(url.host).toBe(WIKIDATA_API_HOST);
    expect(url.searchParams.get('action')).toBe('wbsearchentities');
    expect(url.searchParams.get('search')).toBe('Blade Runner');
    // Without `origin=*` the Action API refuses to answer a cross-origin request at all.
    expect(url.searchParams.get('origin')).toBe('*');
  });

  it('identifies the caller with Api-User-Agent, since fetch cannot set User-Agent', () => {
    const { headers } = provider.buildSearchRequest({ name: 'Blade Runner', year: null });
    expect(headers['Api-User-Agent']).toContain('Gubbins');
    expect(headers).not.toHaveProperty('User-Agent');
  });

  it('leaves the year out of the search term', () => {
    // `wbsearchentities` matches labels and aliases, not free text: "Blade Runner 1982" matches
    // nothing, so appending the year would turn a working search into an empty one.
    const request = provider.buildSearchRequest({ name: 'Blade Runner', year: 1982 });
    expect(new URL(request.url).searchParams.get('search')).toBe('Blade Runner');
  });
});

describe('wikidata-film — parsing a search response', () => {
  it('preserves the API’s relevance order, novel first, film fourth', () => {
    const result = provider.parseSearchResponse(SEARCH_BODY);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.map((c) => c.id)).toEqual(['Q605249', 'Q881018', 'Q4923701', 'Q184843']);
    expect(result.value[0]!.label).toBe('Do Androids Dream of Electric Sheep?');
    expect(result.value[3]!.description).toBe('1982 film by Ridley Scott');
  });

  it('reads a year out of the description, so the picker can mark an agreeing candidate', () => {
    const result = provider.parseSearchResponse(SEARCH_BODY);
    if (!result.ok) throw new Error('expected candidates');
    expect(result.value.map((c) => c.year)).toEqual([null, 1997, 1985, 1982]);
  });

  it('drops a hit with no usable id or label rather than offering an unpickable row', () => {
    const body = JSON.stringify({
      search: [
        { id: 'not-a-qid', label: 'Nope' },
        { id: 'Q1', label: '   ' },
        { id: 'Q2', label: 'Real' },
      ],
    });
    const result = provider.parseSearchResponse(body);
    if (!result.ok) throw new Error('expected candidates');
    expect(result.value.map((c) => c.id)).toEqual(['Q2']);
  });

  it('de-duplicates a repeated id, so the user never chooses between two identical rows', () => {
    const body = JSON.stringify({
      search: [
        { id: 'Q1', label: 'A' },
        { id: 'Q1', label: 'A' },
      ],
    });
    const result = provider.parseSearchResponse(body);
    if (!result.ok) throw new Error('expected candidates');
    expect(result.value).toHaveLength(1);
  });

  it('reports NO_MATCHES for an empty result and UNREADABLE for a body it cannot read', () => {
    expect(provider.parseSearchResponse(JSON.stringify({ search: [] }))).toEqual({
      ok: false,
      failure: { code: 'NO_MATCHES' },
    });
    expect(provider.parseSearchResponse('<html>rate limited</html>')).toEqual({
      ok: false,
      failure: { code: 'UNREADABLE' },
    });
    expect(provider.parseSearchResponse(JSON.stringify({ query: {} }))).toEqual({
      ok: false,
      failure: { code: 'UNREADABLE' },
    });
  });
});

describe('wikidata-film — the detail request', () => {
  it('queries SPARQL for the chosen entity', () => {
    const request = provider.buildDetailRequest('Q184843');
    expect(request).not.toBeNull();
    const url = new URL(request!.url);
    expect(url.host).toBe(WIKIDATA_SPARQL_HOST);
    expect(url.searchParams.get('query')).toContain('wd:Q184843');
    expect(url.searchParams.get('format')).toBe('json');
  });

  it('refuses to build a request for anything that is not a Wikidata item id', () => {
    // The id is interpolated into a SPARQL query, so it is re-checked here rather than trusted
    // from the caller — even though every id this provider emits came from its own parser.
    for (const id of ['', 'Q', 'Q0', 'P31', 'Q1 } DELETE {', '../etc', 'q184843']) {
      expect(provider.buildDetailRequest(id), id).toBeNull();
    }
  });
});

describe('wikidata-film — parsing a detail response', () => {
  it('reads every output key, including the IMDb link built from the open database’s id', () => {
    const result = provider.parseDetailResponse(DETAIL_BODY);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toEqual({
      title: 'Blade Runner',
      director: 'Ridley Scott',
      cast: 'Harrison Ford, Rutger Hauer, Sean Young',
      genre: 'science fiction film, film noir, cyberpunk',
      releaseYear: 1982,
      runtimeMinutes: 112,
      studio: 'The Ladd Company, Warner Bros. Entertainment',
      imdbUrl: 'https://www.imdb.com/title/tt0083658/',
    });
  });

  it('emits an output key the entity has nothing for as null, never as an empty string', () => {
    const body = JSON.stringify({
      results: { bindings: [{ title: literal('Some film'), directors: literal('') }] },
    });
    const result = provider.parseDetailResponse(body);
    if (!result.ok) throw new Error('expected values');
    expect(result.value.title).toBe('Some film');
    expect(result.value.director).toBeNull();
    expect(result.value.imdbUrl).toBeNull();
  });

  it('refuses a non-positive or non-numeric year/runtime rather than offering corrupt data', () => {
    const body = JSON.stringify({
      results: { bindings: [{ title: literal('X'), year: literal('0'), runtime: literal('n/a') }] },
    });
    const result = provider.parseDetailResponse(body);
    if (!result.ok) throw new Error('expected values');
    expect(result.value.releaseYear).toBeNull();
    expect(result.value.runtimeMinutes).toBeNull();
  });

  it('rounds a fractional runtime, which SPARQL returns as a decimal', () => {
    const body = JSON.stringify({ results: { bindings: [{ runtime: literal('112.4') }] } });
    const result = provider.parseDetailResponse(body);
    if (!result.ok) throw new Error('expected values');
    expect(result.value.runtimeMinutes).toBe(112);
  });

  it('reports NOT_FOUND when the entity yielded nothing at all', () => {
    expect(provider.parseDetailResponse(JSON.stringify({ results: { bindings: [] } }))).toEqual({
      ok: false,
      failure: { code: 'NOT_FOUND' },
    });
    // Every key empty means the chosen entity is not a film — reported, rather than presented as
    // an empty plan the user has to interpret.
    expect(provider.parseDetailResponse(JSON.stringify({ results: { bindings: [{}] } }))).toEqual({
      ok: false,
      failure: { code: 'NOT_FOUND' },
    });
  });

  it('never throws on a hostile binding row — a pure seam must return, not raise', () => {
    // `bindings[0]` being `null` passes an `=== undefined` guard and then throws on the first
    // property read, out of a function the descriptor promises is pure and never throws. Every
    // other primitive is harmless (`(42).imdbId` is `undefined`), so `null` is the one hole.
    for (const member of [null, 42, 'nope', []]) {
      const body = JSON.stringify({ results: { bindings: [member] } });
      expect(() => provider.parseDetailResponse(body), JSON.stringify(member)).not.toThrow();
      expect(provider.parseDetailResponse(body).ok, JSON.stringify(member)).toBe(false);
    }
  });

  it('reports UNREADABLE for a body that is not a SPARQL result', () => {
    expect(provider.parseDetailResponse('not json')).toEqual({ ok: false, failure: { code: 'UNREADABLE' } });
    expect(provider.parseDetailResponse(JSON.stringify({ boom: true }))).toEqual({
      ok: false,
      failure: { code: 'UNREADABLE' },
    });
  });
});
