/**
 * The `wikidata-film` lookup provider (issue #616, phase L1).
 *
 * ## Why Wikidata, and not IMDb
 *
 * The issue asks for "Get from IMDb", and **IMDb itself cannot be called**: its official API is
 * a paid AWS Data Exchange product needing a backend, its bulk datasets are hundreds of
 * megabytes of non-commercially-licensed TSV, and scraping `imdb.com` is against their terms and
 * would widen the extension's deliberately-narrow fetch allow-list. OMDb and TMDB both require
 * an API key, which is deferred until a user-supplied credential has a design of its own.
 *
 * Wikidata needs no key, answers with `access-control-allow-origin: *`, **and carries the IMDb
 * id** — so the user still gets their IMDb link, sourced from an open database rather than from
 * IMDb. The honest framing for the UI is "fill from an open film database, including its IMDb
 * link", never "from IMDb", which would misdescribe where the data came from.
 *
 * ## Two endpoints, two hosts
 *
 * - **Search** — the MediaWiki Action API's `wbsearchentities` on `www.wikidata.org`, which
 *   returns candidates in *relevance* order with a label and a one-line description.
 * - **Detail** — a SPARQL query on `query.wikidata.org`, which resolves the referenced entities'
 *   labels (a director is an entity, not a string) in one round trip.
 *
 * Both hosts must be allow-listed in **two independent places**, each with its own guard test:
 * the extension manifest via `parsers/suppliers.ts`, and CSP `connect-src` in `src/csp.ts`.
 *
 * ## Search never auto-applies
 *
 * The first hit for `Blade Runner` is `Q605249` — Philip K. Dick's novel *Do Androids Dream of
 * Electric Sheep?*, because "Blade Runner" is a registered alias of it. A provider that took the
 * top hit would confidently fill a film's fields from a book. Hence the mandatory match picker:
 * this module's job ends at *candidates*, and the runner will not fetch detail until the user has
 * chosen one.
 */
import type {
  LookupCandidate,
  LookupOutputDef,
  LookupProvider,
  LookupQuery,
  LookupRequest,
  LookupResult,
  LookupValues,
} from '../types';

/** The Action API host — entity search. */
export const WIKIDATA_API_HOST = 'www.wikidata.org';
/** The SPARQL host — the detail query. */
export const WIKIDATA_SPARQL_HOST = 'query.wikidata.org';

/**
 * How this app identifies itself to Wikidata.
 *
 * Wikidata asks callers to identify themselves, and a browser `fetch` **cannot set
 * `User-Agent`** — it is a forbidden header the browser controls. Wikidata accepts
 * `Api-User-Agent` as a settable substitute, and both endpoints list it in their CORS
 * `access-control-allow-headers`, so it survives the preflight. Carries only the app name and
 * its public repository — nothing about the user or their inventory.
 */
const API_USER_AGENT = 'Gubbins/1.0 (https://github.com/BootBlock/Gubbins)';

const REQUEST_HEADERS: Readonly<Record<string, string>> = {
  Accept: 'application/json',
  'Api-User-Agent': API_USER_AGENT,
};

/**
 * How many candidates the match picker offers.
 *
 * Enough for the right film to be present when the top hits are a novel and two video games (the
 * Blade Runner case exactly), while staying a list a person can read rather than scroll.
 */
const SEARCH_LIMIT = 10;

/**
 * A Wikidata item id, strictly. Every id this provider emits comes from its own parsed search
 * response, but {@link buildDetailRequest} re-checks rather than trusting its caller: the id is
 * interpolated into a SPARQL query, so anything other than `Q` followed by digits must never
 * reach one. A non-matching id yields no request at all.
 */
const QID_PATTERN = /^Q[1-9][0-9]*$/;

/**
 * What this provider can fill, and the field name each value expects.
 *
 * Default names are lifted **verbatim** from the shipped `Movie` preset, so an untouched preset
 * category binds every key with no configuration at all. `builtin:name` is addressed by its
 * reserved id rather than by the name "Name", because a category may legitimately have a *custom*
 * field called that.
 */
const OUTPUTS: readonly LookupOutputDef[] = [
  { key: 'title', type: 'TEXT', defaultTarget: 'builtin:name' },
  { key: 'director', type: 'TEXT', defaultTarget: 'Director' },
  { key: 'cast', type: 'LONG_TEXT', defaultTarget: 'Cast' },
  { key: 'genre', type: 'TEXT', defaultTarget: 'Genre' },
  { key: 'releaseYear', type: 'NUMBER', defaultTarget: 'Release year' },
  { key: 'runtimeMinutes', type: 'NUMBER', defaultTarget: 'Runtime (min)' },
  { key: 'studio', type: 'TEXT', defaultTarget: 'Studio' },
  { key: 'imdbUrl', type: 'URL', defaultTarget: 'Reference (IMDb/TMDB)' },
];

/**
 * The SPARQL detail query for one film.
 *
 * Every multi-valued property is aggregated in **its own sub-select** rather than in one flat
 * `WHERE`. That is not stylistic: a film has a dozen genres, a dozen cast members, several
 * production companies and more than one runtime (theatrical vs director's cut), and a single
 * pattern would cross-product them into thousands of rows before the aggregate collapsed them.
 * Independent sub-selects keep it to exactly one row, always — which is also what lets the parser
 * read a single binding rather than fold a result set.
 *
 * `MIN` for the year and the runtime picks the original release and the theatrical cut, which is
 * the answer a user cataloguing a film expects. The user reviews every value before it lands, so
 * a choice they disagree with costs them a tick rather than a wrong write.
 */
function detailQuery(qid: string): string {
  const entity = `wd:${qid}`;
  const single = (alias: string, pattern: string): string =>
    `{ SELECT (SAMPLE(?v) AS ?${alias}) WHERE { OPTIONAL { ${pattern} } } }`;
  const smallest = (alias: string, expression: string, pattern: string): string =>
    `{ SELECT (MIN(${expression}) AS ?${alias}) WHERE { OPTIONAL { ${pattern} } } }`;
  const joined = (alias: string, property: string): string =>
    `{ SELECT (GROUP_CONCAT(DISTINCT ?l; SEPARATOR=", ") AS ?${alias}) WHERE ` +
    `{ OPTIONAL { ${entity} wdt:${property} ?e. ?e rdfs:label ?l. FILTER(LANG(?l) = "en") } } }`;

  return [
    'SELECT ?title ?imdbId ?year ?runtime ?directors ?genres ?studios ?cast WHERE {',
    single('title', `${entity} rdfs:label ?v. FILTER(LANG(?v) = "en")`),
    single('imdbId', `${entity} wdt:P345 ?v`),
    smallest('year', 'YEAR(?v)', `${entity} wdt:P577 ?v`),
    smallest('runtime', '?v', `${entity} wdt:P2047 ?v`),
    joined('directors', 'P57'),
    joined('genres', 'P136'),
    joined('studios', 'P272'),
    joined('cast', 'P161'),
    '}',
  ].join('\n');
}

/** One binding value in a SPARQL JSON result. */
interface SparqlValue {
  readonly value?: unknown;
}

/** The shape of a `wbsearchentities` hit this provider reads. */
interface SearchHit {
  readonly id?: unknown;
  readonly label?: unknown;
  readonly description?: unknown;
}

/** A trimmed non-empty string, or null — the one place "the source said nothing" is decided. */
function text(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

/**
 * A finite integer from a SPARQL literal, or null.
 *
 * SPARQL returns numbers as strings with a datatype, and a runtime comes back as a decimal
 * (`"112"`), so this rounds rather than rejecting a fractional value. Non-finite and
 * non-positive values are refused: a year of 0 or a runtime of -1 is corrupt data, not a value
 * worth offering the user.
 */
function positiveInteger(value: unknown): number | null {
  const raw = text(value);
  if (raw === null) return null;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return Math.round(parsed);
}

/**
 * The year out of a Wikidata description, where it opens with one ("1982 film by Ridley Scott").
 *
 * Best-effort presentation only — it gives the match picker a year column without a second
 * network round trip. A description that doesn't start with a plausible year simply yields null
 * and the picker shows the description alone; nothing is *filled* from this (the year that lands
 * on the item comes from the detail query's `P577`).
 */
function yearFromDescription(description: string | null): number | null {
  const match = /^(1[0-9]{3}|20[0-9]{2})\b/.exec(description ?? '');
  return match === null ? null : Number(match[1]);
}

/**
 * Build the `wbsearchentities` request for the item's name.
 *
 * The item's year is deliberately **not** folded into the search term. `wbsearchentities` matches
 * labels and aliases, not free text, so `"Blade Runner 1982"` matches nothing at all while
 * `"Blade Runner"` returns the film fourth — appending the year would turn a working search into
 * an empty one. The year earns its keep in the match picker instead, which marks the candidate
 * whose year agrees with the item's; it informs the user's choice rather than making it.
 */
function buildSearchRequest(query: LookupQuery): LookupRequest {
  const params = new URLSearchParams({
    action: 'wbsearchentities',
    search: query.name.trim(),
    language: 'en',
    uselang: 'en',
    type: 'item',
    format: 'json',
    formatversion: '2',
    limit: String(SEARCH_LIMIT),
    // Required for the Action API to answer a cross-origin request at all.
    origin: '*',
  });
  return { url: `https://${WIKIDATA_API_HOST}/w/api.php?${params.toString()}`, headers: REQUEST_HEADERS };
}

/** Read a `wbsearchentities` body into candidates, preserving the API's relevance order. */
function parseSearchResponse(body: string): LookupResult<readonly LookupCandidate[]> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return { ok: false, failure: { code: 'UNREADABLE' } };
  }
  const hits = (parsed as { search?: unknown } | null)?.search;
  if (!Array.isArray(hits)) return { ok: false, failure: { code: 'UNREADABLE' } };

  const candidates: LookupCandidate[] = [];
  const seen = new Set<string>();
  for (const hit of hits as readonly SearchHit[]) {
    const id = text(hit?.id);
    // A hit with no usable id could never be fetched, and one already listed would give the user
    // the same row twice to choose between.
    if (id === null || !QID_PATTERN.test(id) || seen.has(id)) continue;
    const label = text(hit?.label);
    if (label === null) continue;
    seen.add(id);
    const description = text(hit?.description);
    candidates.push({ id, label, description, year: yearFromDescription(description) });
  }
  if (candidates.length === 0) return { ok: false, failure: { code: 'NO_MATCHES' } };
  return { ok: true, value: candidates };
}

/** Build the SPARQL detail request for a chosen candidate, or null if its id isn't a QID. */
function buildDetailRequest(candidateId: string): LookupRequest | null {
  if (!QID_PATTERN.test(candidateId)) return null;
  const params = new URLSearchParams({ query: detailQuery(candidateId), format: 'json' });
  return {
    url: `https://${WIKIDATA_SPARQL_HOST}/sparql?${params.toString()}`,
    headers: { ...REQUEST_HEADERS, Accept: 'application/sparql-results+json' },
  };
}

/** Read the SPARQL detail body into per-output-key values. */
function parseDetailResponse(body: string): LookupResult<LookupValues> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return { ok: false, failure: { code: 'UNREADABLE' } };
  }
  const bindings = (parsed as { results?: { bindings?: unknown } } | null)?.results?.bindings;
  if (!Array.isArray(bindings)) return { ok: false, failure: { code: 'UNREADABLE' } };
  // The query aggregates into exactly one row by construction, so a result with none means the
  // entity carried nothing at all — a legitimate "no data for this", not a malformed answer.
  const row = bindings[0] as Readonly<Record<string, SparqlValue | undefined>> | undefined;
  if (row === undefined) return { ok: false, failure: { code: 'NOT_FOUND' } };

  const imdbId = text(row.imdbId?.value);
  const values: LookupValues = {
    title: text(row.title?.value),
    director: text(row.directors?.value),
    cast: text(row.cast?.value),
    genre: text(row.genres?.value),
    releaseYear: positiveInteger(row.year?.value),
    runtimeMinutes: positiveInteger(row.runtime?.value),
    studio: text(row.studios?.value),
    // The IMDb *link* the issue actually asked for, built from the id an open database holds.
    imdbUrl: imdbId === null ? null : `https://www.imdb.com/title/${encodeURIComponent(imdbId)}/`,
  };
  // Every key empty means the QID resolved to something that is not a film (or to nothing) —
  // reported rather than presented as an empty plan the user would have to interpret.
  if (Object.values(values).every((value) => value === null)) {
    return { ok: false, failure: { code: 'NOT_FOUND' } };
  }
  return { ok: true, value: values };
}

/** The `wikidata-film` provider descriptor. */
export const WIKIDATA_FILM_PROVIDER: LookupProvider = {
  id: 'wikidata-film',
  hosts: [WIKIDATA_API_HOST, WIKIDATA_SPARQL_HOST],
  // Wikidata throttles SPARQL, and a lookup is two requests deep. One second between them keeps
  // this a considerate client without the user noticing a wait they didn't ask for.
  minIntervalMs: 1000,
  sourceName: 'Wikidata',
  sourceUrl: 'https://www.wikidata.org',
  outputs: OUTPUTS,
  yearOutputKey: 'releaseYear',
  // A film is searched for by name. Nothing else the item carries identifies one, so an unnamed
  // item can offer no lookup and the affordance does not render.
  canSearch: (query) => query.name.trim().length > 0,
  buildSearchRequest,
  parseSearchResponse,
  buildDetailRequest,
  parseDetailResponse,
};
