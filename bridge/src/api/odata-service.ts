/**
 * A small but **genuinely conformant OData v4 read service**, mounted at `GET /api/v1/odata`.
 *
 * The bridge already spoke OData's *dialect* — `$select`/`$expand`/`$top`/`$skip`/`$orderby`/
 * `$filter`/`$count`/`$search` on the plain REST endpoints, plus a CSDL `$metadata` document.
 * What it did not do was speak the *protocol*: an OData client that read the CSDL went on to
 * `GET /items` and found `{ data, pagination }` where OData JSON Format §4.5/§10 requires a
 * top-level `@odata.context` and a `value` array, with no `OData-Version` header and no service
 * document at the root (Protocol §8.1.5, §11.1.1). Every real client — Excel/Power Query, Power
 * BI, `Simple.OData.Client` — fails at the first entity-set read. Advertising `$metadata` while
 * emitting none of the envelope is the bug this module closes (issue #361).
 *
 * The fix is a **separate service root** rather than a change to the existing endpoints:
 *
 *   - `/api/v1/odata`             → the service document (the entity sets on offer)
 *   - `/api/v1/odata/$metadata`   → the CSDL, unchanged, now reachable from its own service root
 *   - `/api/v1/odata/items`       → `{ "@odata.context", "@odata.count"?, "value", "@odata.nextLink"? }`
 *   - `/api/v1/odata/items('id')` → one entity, context-qualified with `/$entity`
 *   - `/api/v1/odata/items/$count`→ the bare `text/plain` total
 *
 * `/api/v1/items` and friends keep their exact `{ data, pagination }` contract — the Home
 * Assistant integration and every existing consumer are untouched. Both surfaces read through
 * the one engine in `reads.ts`, so the two envelopes can never describe different row sets.
 *
 * **Honesty over reach.** The service implements the query subset the bridge actually has, and
 * the CSDL says so in `Org.OData.Capabilities.V1` terms — which entity sets are filterable,
 * sortable, countable and searchable, and on which properties. A client that reads those
 * annotations pushes down only what works and evaluates the rest itself, instead of receiving a
 * `400` mid-refresh. Anything outside the subset is refused with a message naming what *is*
 * supported (Protocol §11.2.5 requires a service to fail an unsupported system query option
 * rather than quietly ignore it), and nothing here is writable.
 *
 * The `OData-Version: 4.0` header every response must carry is stamped for the whole sub-tree in
 * `server.ts`, so a guard response (`401`/`403`/`429`/`503`) is as conformant as a routed one.
 */
import type { ServerResponse } from 'node:http';
import { sendError, sendODataJson, sendText, sendXml } from './respond.ts';
import { odataMetadataXml } from './odata-metadata.ts';
import {
  buildCategoryEntity,
  buildCategoryList,
  buildItemCount,
  buildItemEntity,
  buildItemList,
  buildLocationEntity,
  buildLocationList,
  type Driver,
  type EntityResult,
  type ListResult,
} from './reads.ts';

/** The OData protocol version this service speaks (Protocol §8.1.5). */
export const ODATA_VERSION = '4.0';

/** The entity sets the service document advertises — the names the CSDL container declares. */
export const ODATA_ENTITY_SETS = ['items', 'locations', 'categories'] as const;

type EntitySetName = (typeof ODATA_ENTITY_SETS)[number];

/**
 * The system query options each entity set genuinely supports, per addressed resource kind.
 *
 * Only `items` is backed by the search AST, so only it can filter, sort, search or count;
 * `locations` and `categories` are plain paged reads. This table is the single source of the
 * `400`s below **and** of the capability annotations in the CSDL — see `odata-metadata.ts`,
 * whose `ENTITY_SET_CAPABILITIES` says the same thing in vocabulary terms. A client that trusts
 * the metadata and a client that just tries it get the same answer.
 */
const SUPPORTED_OPTIONS: Readonly<
  Record<
    EntitySetName,
    {
      readonly collection: readonly string[];
      readonly entity: readonly string[];
      /** `null` when the set is not countable, so `/$count` is not addressable on it. */
      readonly count: readonly string[] | null;
    }
  >
> = {
  items: {
    collection: [
      '$select',
      '$expand',
      '$filter',
      '$search',
      '$orderby',
      '$top',
      '$skip',
      '$count',
      '$format',
    ],
    entity: ['$select', '$expand', '$format'],
    count: ['$filter', '$search', '$format'],
  },
  locations: {
    collection: ['$select', '$expand', '$top', '$skip', '$format'],
    entity: ['$select', '$expand', '$format'],
    count: null,
  },
  categories: {
    collection: ['$top', '$skip', '$format'],
    entity: ['$format'],
    count: null,
  },
};

/** One addressed resource below the service root. */
interface ResourceRef {
  readonly set: EntitySetName;
  /** The entity key when a single entity was addressed (`items('abc')`); `null` for a collection. */
  readonly key: string | null;
  /** True for the `…/$count` raw-value path. */
  readonly count: boolean;
}

/**
 * Route a request below `/api/v1/odata`. `segments` are the path segments *below* the service
 * root (so `[]` is the service document itself), and `serviceRoot` is the absolute URL of that
 * root — context URLs and `@odata.nextLink` must be resolvable by the client, so they are
 * emitted absolute rather than relative to whatever base it guessed.
 *
 * The service document and `$metadata` describe the service rather than any inventory, so — like
 * the discovery index — they answer before the snapshot gate; every data read waits for a
 * snapshot and answers `503` until one has loaded.
 */
export async function handleOData(
  res: ServerResponse,
  url: URL,
  segments: readonly string[],
  serviceRoot: string,
  getDriver: () => Driver | null,
): Promise<void> {
  if (segments.length === 0) return void sendServiceDocument(res, serviceRoot);
  if (segments.length === 1 && segments[0] === '$metadata') {
    return void sendXml(res, 200, odataMetadataXml());
  }

  const ref = parseResourcePath(segments);
  if (ref === null) return void notFound(res);

  const supported = SUPPORTED_OPTIONS[ref.set];
  const allowed = ref.count ? supported.count : ref.key !== null ? supported.entity : supported.collection;
  // A `/$count` on a set the service cannot count is not an addressable resource at all.
  if (allowed === null) return void notFound(res);

  const optionError = validateOptions(url, ref, allowed);
  if (optionError !== null) return void badRequest(res, optionError);

  const driver = getDriver();
  if (driver === null) {
    return void sendError(res, 503, 'snapshot_unavailable', 'Snapshot not loaded yet', { v1: true });
  }

  if (ref.count) {
    // `items` is the only countable set — the others declare `Countable="false"` in the CSDL and
    // were answered `404` above, so reaching here means the item count.
    const total = await buildItemCount(res, driver, url);
    if (total === null) return; // a 400 was already sent
    return void sendText(res, 200, String(total));
  }

  if (ref.key !== null) {
    return void sendEntity(res, serviceRoot, ref.set, await readEntity(res, driver, url, ref.set, ref.key));
  }

  const result = await readCollection(res, driver, url, ref.set);
  if (result === null) return; // a 400 was already sent
  sendCollection(res, url, serviceRoot, ref.set, result);
}

// --- reading ------------------------------------------------------------------------

/** Read one collection page through the shared engine. `null` ⇒ a `400` has already been sent. */
async function readCollection(
  res: ServerResponse,
  driver: Driver,
  url: URL,
  set: EntitySetName,
): Promise<ListResult | null> {
  const result = await readCollectionPage(res, driver, url, set);

  // `$top=0` is a legitimate OData request for "no rows, just the envelope", and the shared paging
  // bounds would clamp it up to a page of one. Rather than a second, half-validated code path, the
  // normal read runs — so every option is still validated and `$count` still answered — and its
  // rows are dropped. That costs one small page read on a request which by definition wants none.
  if (result === null || readRequestedTop(url) !== 0) return result;
  return { ...result, rows: [], hasMore: false };
}

function readCollectionPage(
  res: ServerResponse,
  driver: Driver,
  url: URL,
  set: EntitySetName,
): Promise<ListResult | null> {
  switch (set) {
    case 'items':
      return buildItemList(res, driver, url);
    case 'locations':
      return buildLocationList(res, driver, url);
    case 'categories':
      return buildCategoryList(driver, url);
  }
}

/** Read one entity by key through the shared engine. */
function readEntity(
  res: ServerResponse,
  driver: Driver,
  url: URL,
  set: EntitySetName,
  key: string,
): Promise<EntityResult> {
  switch (set) {
    case 'items':
      return buildItemEntity(res, driver, url, key);
    case 'locations':
      return buildLocationEntity(res, driver, url, key);
    case 'categories':
      return buildCategoryEntity(driver, key);
  }
}

// --- responses ----------------------------------------------------------------------

/**
 * The service document (Protocol §11.1.1) — the first thing an OData client reads, and the
 * document whose absence made the service undiscoverable. Each entry names an entity set and
 * the URL to reach it, relative to the service root.
 */
function sendServiceDocument(res: ServerResponse, serviceRoot: string): void {
  sendODataJson(res, 200, {
    '@odata.context': `${serviceRoot}/$metadata`,
    value: ODATA_ENTITY_SETS.map((name) => ({ name, kind: 'EntitySet', url: name })),
  });
}

/**
 * A collection response: the context URL, the optional inline count, the rows under `value`, and
 * a `@odata.nextLink` when more rows remain.
 */
function sendCollection(
  res: ServerResponse,
  url: URL,
  serviceRoot: string,
  set: EntitySetName,
  result: ListResult,
): void {
  const next = nextLink(url, serviceRoot, set, result);
  sendODataJson(res, 200, {
    '@odata.context': contextUrl(serviceRoot, set, result.selected),
    ...(result.total !== undefined ? { '@odata.count': result.total } : {}),
    value: result.rows,
    ...(next !== null ? { '@odata.nextLink': next } : {}),
  });
}

/** A single-entity response, or the `404` for a key that matches nothing. */
function sendEntity(
  res: ServerResponse,
  serviceRoot: string,
  set: EntitySetName,
  result: EntityResult,
): void {
  if (result.kind === 'handled') return; // a 400 was already sent
  if (result.kind === 'missing') return void notFound(res);
  sendODataJson(res, 200, {
    '@odata.context': `${contextUrl(serviceRoot, set, result.selected)}/$entity`,
    ...(result.entity as Record<string, unknown>),
  });
}

/**
 * The context URL for an entity set (OData JSON §10.1–10.2). A projected payload names the
 * properties it kept, so a client isn't left to guess whether a missing property was deselected
 * or simply absent.
 */
function contextUrl(serviceRoot: string, set: EntitySetName, selected?: readonly string[]): string {
  const projection = selected === undefined ? '' : `(${selected.join(',')})`;
  return `${serviceRoot}/$metadata#${set}${projection}`;
}

/**
 * The link to the next page, or `null` when this page is the last one.
 *
 * The bridge caps a page at the API's `MAX_PAGE_LIMIT` rows, so a client asking for more than
 * that gets server-driven paging (Protocol §11.2.5.7): every other query option is carried forward
 * verbatim, `$skip` advances past what was returned, and — when the caller *did* set a `$top` —
 * the link's `$top` is reduced by the rows already delivered, so following the chain returns
 * exactly the number asked for rather than that many per page.
 *
 * `hasMore` is true whenever a full page came back, so on an exact-boundary last page the link
 * is present and leads to an empty collection. That is a legal (if slightly wasteful) OData
 * conversation, and the alternative — a count query on every page — is not worth it.
 */
function nextLink(url: URL, serviceRoot: string, set: EntitySetName, result: ListResult): string | null {
  if (!result.hasMore) return null;

  const requestedTop = readRequestedTop(url);
  const remaining = requestedTop === null ? null : requestedTop - result.rows.length;
  if (remaining !== null && remaining <= 0) return null;

  const link = new URL(`${serviceRoot}/${set}`);
  for (const [key, value] of url.searchParams) {
    // Both spellings of the cursor are rewritten below (a `$skip` outranks an `offset`, so
    // carrying the stale `offset` forward would be at best redundant and at worst confusing);
    // `limit` is kept, so the next page is the size this one was. `token` can only be a
    // credential, and a link the client stores or logs must never carry one.
    if (key === '$top' || key === '$skip' || key === 'offset' || key === 'token') continue;
    link.searchParams.append(key, value);
  }
  link.searchParams.set('$skip', String(result.page.offset + result.rows.length));
  if (remaining !== null) link.searchParams.set('$top', String(remaining));
  return link.href;
}

function notFound(res: ServerResponse): void {
  sendError(res, 404, 'not_found', 'Not found', { v1: true });
}

function badRequest(res: ServerResponse, message: string): void {
  sendError(res, 400, 'bad_request', message, { v1: true });
}

// --- request parsing ----------------------------------------------------------------

/**
 * Parse the addressed resource, or `null` when the path names nothing this service serves.
 *
 * Accepts the canonical key-in-parentheses forms every client emits: `items('abc')`, the
 * unquoted `items(abc)`, and the named-key `items(id='abc')`. A doubled quote inside a quoted
 * key is OData's escape for a literal one.
 */
function parseResourcePath(segments: readonly string[]): ResourceRef | null {
  if (segments.length < 1 || segments.length > 2) return null;

  const match = /^([A-Za-z][A-Za-z0-9_]*)(?:\((.*)\))?$/.exec(decodeSegment(segments[0]!));
  if (match === null) return null;
  const [, name, rawKey] = match as unknown as [string, string, string | undefined];
  if (!isEntitySet(name)) return null;

  const key = rawKey === undefined ? null : parseKey(rawKey);
  if (rawKey !== undefined && key === null) return null; // `items()` — a key was promised, none given

  if (segments.length === 2) {
    // `/$count` addresses the *collection*, so it cannot follow a key.
    if (segments[1] !== '$count' || key !== null) return null;
    return { set: name, key: null, count: true };
  }
  return { set: name, key, count: false };
}

function isEntitySet(name: string): name is EntitySetName {
  return (ODATA_ENTITY_SETS as readonly string[]).includes(name);
}

/** The literal key an `(…)` segment carries, or `null` when it carries none. */
function parseKey(raw: string): string | null {
  // The named-key form `(id='abc')` addresses the same single-part key as `('abc')`.
  const named = /^\s*id\s*=\s*(.*)$/.exec(raw);
  const literal = (named === null ? raw : named[1]!).trim();
  if (literal.length === 0) return null;
  if (literal.length >= 2 && literal.startsWith("'") && literal.endsWith("'")) {
    return literal.slice(1, -1).replace(/''/g, "'");
  }
  return literal;
}

/** Percent-decode one path segment, falling back to the raw text on malformed input. */
function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

/**
 * Reject any system query option this resource does not support, and any `$format` other than
 * JSON. Custom (non-`$`) query options are always allowed — Protocol §11.2.2 reserves only the
 * `$` and `@` prefixes — which is what keeps the bridge's own `location`/`category`/
 * `includeInactive`/`fields`/`include` names usable here.
 *
 * Returns the caller-facing message, or `null` when the request is acceptable.
 */
function validateOptions(url: URL, ref: ResourceRef, allowed: readonly string[]): string | null {
  const resource = ref.count
    ? `the ${ref.set}/$count path`
    : ref.key !== null
      ? `a single ${ref.set} entity`
      : `the ${ref.set} entity set`;

  for (const key of url.searchParams.keys()) {
    if (!key.startsWith('$')) continue;
    if (!allowed.includes(key)) {
      return `"${key}" is not supported on ${resource}. Supported here: ${allowed.join(', ')}.`;
    }
  }

  const format = url.searchParams.get('$format');
  if (format !== null && !isJsonFormat(format)) {
    return `"$format=${format}" is not supported; this service emits JSON only.`;
  }

  for (const option of ['$top', '$skip'] as const) {
    const raw = url.searchParams.get(option);
    if (raw !== null && !isNonNegativeInteger(raw)) {
      return `"${option}" must be a non-negative integer, got "${raw}".`;
    }
  }

  return null;
}

/** Whether a `$format` value asks for JSON (`json`, `application/json`, either with parameters). */
function isJsonFormat(format: string): boolean {
  const media = format.split(';')[0]!.trim().toLowerCase();
  return media === 'json' || media === 'application/json';
}

function isNonNegativeInteger(raw: string): boolean {
  return /^\d+$/.test(raw.trim());
}

/**
 * The `$top` the caller actually asked for, before the API's page cap clamped it — or `null` when
 * they set none.
 *
 * Deliberately **not** falling back to the bridge's own `limit`, even though `readPage` treats
 * one as an alias of the other: they mean different things to the paging link. `$top` is a cap on
 * the *whole result*, so once that many rows have been delivered the collection is complete and
 * there is no next page; `limit` is a page size, and a client using it expects the link to keep
 * going. Conflating them would silently truncate a `limit`-paged read at one page.
 */
function readRequestedTop(url: URL): number | null {
  const raw = url.searchParams.get('$top');
  if (raw === null || !isNonNegativeInteger(raw)) return null;
  const value = Number(raw);
  return Number.isSafeInteger(value) ? value : null;
}
