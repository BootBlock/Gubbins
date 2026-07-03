/**
 * Versioned read-only REST API (`/api/v1`) — the generic, third-party-facing surface that
 * the Home Assistant integration is now just one consumer of.
 *
 * It is **purely additive**: the legacy `/health`, `/search`, `/where` paths (the shipped
 * contract HA depends on) keep their exact behaviour and are documented as permanent aliases
 * of their `/api/v1` twins. Everything here is GET-only and strictly read-only — every read
 * flows through the app's own repositories and the single parameterised `parseASTtoSQL`,
 * never bespoke SQL. Auth and the per-IP rate limit are applied by the caller (`server.ts`)
 * before routing here, so this module only handles routing, validation, 404/503, and the
 * `{ error: { code, message } }` envelope.
 */
import type { ServerResponse } from 'node:http';
import { ItemRepository } from '@/db/repositories/ItemRepository.ts';
import { LocationRepository } from '@/db/repositories/LocationRepository.ts';
import { CategoryRepository } from '@/db/repositories/CategoryRepository.ts';
import { emptyAst } from '@/db/search/ast.ts';
import type { LocationTreeNode } from '@/db/repositories/types';
import { searchItems, searchItemRows, whereIs } from '../query.ts';
import { openapiDocument } from '../openapi.ts';
import type { BridgeServerState, ParsedBody, PushCapability, WriteCapability } from '../server.ts';
import { WriteError, type WriteOperation } from '../write.ts';
import { sendError, sendJson, sendText, sendXml, sendCsv } from './respond.ts';
import { readPage, readQueryParam, readResultLimit, type PageRequest } from './params.ts';
import { MAX_CSV_ROWS, MAX_PAGE_LIMIT } from './limits.ts';
import { odataMetadataXml } from './odata-metadata.ts';
import { buildItemsCsv } from '@/features/export/export-data.ts';
import { FieldSelectionError, hasSelection, type RawSelection, type SelectedField } from './field-select.ts';
import {
  createItemViewContext,
  parseItemSelection,
  projectItem,
  ITEM_DETAIL_DEFAULT_FIELDS,
  ITEM_SUMMARY_DEFAULT_FIELDS,
  SEARCH_DEFAULT_FIELDS,
} from './item-view.ts';
import { BadQueryError, parseOrderBy, readOption } from './odata.ts';
import { parseODataFilter } from './odata-filter.ts';
import { SearchAstError } from '@/db/search/parseASTtoSQL.ts';
import type { SearchAST } from '@/db/search/ast.ts';
import type { ItemSort } from '@/db/repositories/item/sql.ts';
import type { Page, Item } from '@/db/repositories/types';
import {
  toCapabilityKey,
  toCategoryDetail,
  toCategorySummary,
  toItemSummary,
  toLocation,
  type ListEnvelope,
  type PaginationMeta,
} from './dto.ts';
import { loadItemDetail } from '../item-detail.ts';

/** The versioned API base path. */
export const API_V1_BASE = '/api/v1';

/** True when a request path belongs to the versioned API (the base itself or below it). */
export function isApiV1Path(pathname: string): boolean {
  return pathname === API_V1_BASE || pathname.startsWith(`${API_V1_BASE}/`);
}

/** Everything the v1 router needs from the request: the method, state accessor, write gate, body. */
export interface ApiV1Context {
  /** The HTTP method (`GET` for reads, `POST` for the opt-in write endpoints). */
  readonly method: string;
  readonly getState: () => BridgeServerState | null;
  /** Present only when writes are opted in; its absence makes every POST a `404`. */
  readonly write?: WriteCapability;
  /**
   * Present only when snapshot-ingest is opted in (`GUBBINS_BRIDGE_ALLOW_PUSH=on`). The ingest
   * POST itself is handled in `server.ts` (it streams the body); this is threaded through only so
   * the discovery index can report `pushable`.
   */
  readonly push?: PushCapability;
  /**
   * Whether the opt-in event stream is enabled (`GUBBINS_BRIDGE_EVENTS=on`, or implied by
   * webhooks). The `GET /api/v1/events` connection itself is handled in `server.ts` (it holds
   * the socket open); this flag is threaded through only so the discovery index can advertise it.
   */
  readonly streamable?: boolean;
  /** The parsed POST body (undefined for GET). */
  readonly body?: ParsedBody;
}

/**
 * Route a `/api/v1` request. The caller has already enforced the method set, auth and the rate
 * limit; any thrown error is caught by the caller and collapsed to a generic 500. `openapi.json`
 * and the index are served regardless of snapshot state; data endpoints answer 503 until a
 * snapshot has loaded. A POST is dispatched to the opt-in write router.
 */
export async function handleApiV1(res: ServerResponse, url: URL, ctx: ApiV1Context): Promise<void> {
  const segments = url.pathname
    .split('/')
    .filter((s) => s.length > 0)
    .slice(2); // drop 'api','v1'

  if (ctx.method === 'POST') return void (await handleWrite(res, segments, ctx));

  // Static, state-independent endpoints first.
  if (segments.length === 0) {
    return void sendJson(
      res,
      200,
      apiIndex(ctx.write !== undefined, ctx.push !== undefined, ctx.streamable === true),
    );
  }
  if (segments.length === 1 && segments[0] === 'openapi.json') {
    return void sendJson(res, 200, openapiDocument);
  }
  if (segments.length === 1 && segments[0] === '$metadata') {
    return void sendXml(res, 200, odataMetadataXml());
  }

  const state = ctx.getState();
  if (state === null) {
    return void sendError(res, 503, 'snapshot_unavailable', 'Snapshot not loaded yet', { v1: true });
  }
  const { driver } = state;

  switch (segments[0]) {
    case 'health':
      if (segments.length === 1) return void (await handleHealth(res, state));
      break;
    case 'search':
      if (segments.length === 1) return void (await handleSearch(res, driver, url));
      break;
    case 'where':
      if (segments.length === 1) return void (await handleWhere(res, driver, url));
      break;
    case 'items':
      if (segments.length === 1) return void (await handleItems(res, driver, url));
      if (segments.length === 2 && segments[1] === '$count') {
        return void (await handleItemCount(res, driver, url));
      }
      if (segments.length === 2) return void (await handleItem(res, driver, url, decode(segments[1]!)));
      break;
    case 'items.csv':
      if (segments.length === 1) return void (await handleItemsCsv(res, driver, url));
      break;
    case 'locations':
      if (segments.length === 1) return void (await handleLocations(res, driver, url));
      if (segments.length === 2) return void (await handleLocation(res, driver, decode(segments[1]!)));
      break;
    case 'categories':
      if (segments.length === 1) return void (await handleCategories(res, driver, url));
      if (segments.length === 2) return void (await handleCategory(res, driver, decode(segments[1]!)));
      break;
    case 'capabilities':
      if (segments.length === 1) return void (await handleCapabilities(res, driver, url));
      break;
  }

  sendError(res, 404, 'not_found', 'Not found', { v1: true });
}

// --- writes (opt-in, off by default) ----------------------------------------------

/**
 * Route a POST to the limited write endpoints. The only valid POST targets are
 * `items/{id}/adjust-quantity` and `items/{id}/adjust-gauge`; both take a `{ delta, note? }` body
 * and round-trip through the §7.3 sync merge (see `write.ts`). A POST to a read resource is a
 * `405`; an unknown item sub-action is a `404`; and when writes are not opted in (`ctx.write`
 * absent) a write path is a `404` too, so the feature is invisible unless enabled.
 */
async function handleWrite(res: ServerResponse, segments: string[], ctx: ApiV1Context): Promise<void> {
  const isItemAction = segments[0] === 'items' && segments.length === 3;
  if (!isItemAction) {
    // POST to a GET resource (e.g. /api/v1/items) or a non-existent path: method not allowed.
    return void sendError(res, 405, 'method_not_allowed', 'Method not allowed', {
      v1: true,
      headers: { allow: 'GET' },
    });
  }
  const action = segments[2];
  if (action !== 'adjust-quantity' && action !== 'adjust-gauge') {
    return void sendError(res, 404, 'not_found', 'Not found', { v1: true }); // unknown sub-action
  }
  if (ctx.write === undefined) {
    return void sendError(res, 404, 'not_found', 'Not found', { v1: true }); // feature off → invisible
  }

  if (ctx.body === undefined || ctx.body.ok === false) {
    return void sendError(res, 400, 'bad_request', 'Request body must be a JSON object.', { v1: true });
  }
  const parsed = parseAdjustBody(ctx.body.value);
  if (!parsed.ok) return void sendError(res, 400, 'bad_request', parsed.message, { v1: true });

  const op: WriteOperation = {
    kind: action,
    itemId: decode(segments[1]!),
    delta: parsed.delta,
    ...(parsed.note !== undefined ? { note: parsed.note } : {}),
  };

  try {
    sendJson(res, 200, await ctx.write.execute(op));
  } catch (err) {
    if (err instanceof WriteError) {
      sendError(res, err.status, err.code, err.message, { v1: true });
      return;
    }
    throw err; // unexpected → the caller's generic 500
  }
}

/** Validate the `{ delta, note? }` adjust body shape (the numeric/integer domain check is the
 * repository's, so it stays single-sourced and yields a 422 with the app's own wording). */
function parseAdjustBody(
  value: unknown,
): { ok: true; delta: number; note?: string } | { ok: false; message: string } {
  if (typeof value !== 'object' || value === null) {
    return { ok: false, message: 'Body must be a JSON object with a numeric "delta".' };
  }
  const record = value as Record<string, unknown>;
  if (typeof record.delta !== 'number' || !Number.isFinite(record.delta)) {
    return { ok: false, message: 'Body must include a finite numeric "delta".' };
  }
  if (record.note !== undefined && record.note !== null && typeof record.note !== 'string') {
    return { ok: false, message: '"note", when present, must be a string.' };
  }
  const note = typeof record.note === 'string' ? record.note : undefined;
  return { ok: true, delta: record.delta, ...(note !== undefined ? { note } : {}) };
}

// --- meta -------------------------------------------------------------------------

function apiIndex(writable: boolean, pushable: boolean, streamable: boolean): unknown {
  return {
    name: 'Gubbins Bridge API',
    version: '1.0.0',
    openapi: `${API_V1_BASE}/openapi.json`,
    /** Whether this bridge has the opt-in write endpoints enabled (read-only when false). */
    writable,
    /** Whether this bridge has the opt-in snapshot-ingest endpoint enabled (PWA "push to bridge"). */
    pushable,
    /** Whether this bridge has the opt-in read-only SSE event stream enabled. */
    streamable,
    endpoints: [
      `${API_V1_BASE}/openapi.json`,
      `${API_V1_BASE}/$metadata`,
      `${API_V1_BASE}/health`,
      `${API_V1_BASE}/search`,
      `${API_V1_BASE}/where`,
      `${API_V1_BASE}/items`,
      `${API_V1_BASE}/items.csv`,
      `${API_V1_BASE}/items/{id}`,
      `${API_V1_BASE}/items/$count`,
      `${API_V1_BASE}/locations`,
      `${API_V1_BASE}/locations/{id}`,
      `${API_V1_BASE}/categories`,
      `${API_V1_BASE}/categories/{id}`,
      `${API_V1_BASE}/capabilities`,
      ...(writable
        ? [`POST ${API_V1_BASE}/items/{id}/adjust-quantity`, `POST ${API_V1_BASE}/items/{id}/adjust-gauge`]
        : []),
      ...(pushable ? [`POST ${API_V1_BASE}/snapshot`] : []),
      ...(streamable ? [`${API_V1_BASE}/events`] : []),
    ],
  };
}

async function handleHealth(res: ServerResponse, state: BridgeServerState): Promise<void> {
  const itemCount = await new ItemRepository(state.driver).countByAst(emptyAst('AND'));
  sendJson(res, 200, { ok: true, itemCount, snapshotGeneratedAt: state.snapshotGeneratedAt });
}

// --- search / where (aliases of the legacy contract, same bodies) -----------------

async function handleSearch(res: ServerResponse, driver: Driver, url: URL): Promise<void> {
  const q = readQueryParam(res, url, true);
  if (q === null) return;
  const limit = readResultLimit(url, true); // versioned API honours the $top alias
  const raw = readSelection(url);

  // With a `fields`/`include` selection, project the raw rows through the item field engine;
  // otherwise keep the compact ItemMatch shape (byte-identical to the legacy /search alias).
  if (hasSelection(raw)) {
    const selection = parseSelectionOr400(res, SEARCH_DEFAULT_FIELDS, raw);
    if (selection === null) return;
    const rows = await searchItemRows(driver, q, { limit });
    const matches = await Promise.all(
      rows.map((row) => projectItem(createItemViewContext(driver, row), selection)),
    );
    return void sendJson(res, 200, { query: q.trim(), matches });
  }

  const matches = await searchItems(driver, q, { limit });
  sendJson(res, 200, { query: q.trim(), matches });
}

async function handleWhere(res: ServerResponse, driver: Driver, url: URL): Promise<void> {
  const q = readQueryParam(res, url, true);
  if (q === null) return;
  sendJson(res, 200, await whereIs(driver, q));
}

// --- items ------------------------------------------------------------------------

async function handleItems(res: ServerResponse, driver: Driver, url: URL): Promise<void> {
  const page = readPage(url);
  const raw = readSelection(url);
  const selection = hasSelection(raw)
    ? parseSelectionOr400(res, ITEM_SUMMARY_DEFAULT_FIELDS, raw)
    : undefined;
  if (selection === null) return; // a 400 was already sent

  const sort = parseOrderByOr400(res, url);
  if (sort === null) return;

  const ast = parseItemFilterOr400(res, url);
  if (ast === null) return; // an invalid $filter already sent a 400

  const items = new ItemRepository(driver);
  const filters = readItemListFilters(url);
  const wantCount = url.searchParams.get('$count') === 'true';

  let result: Page<Item>;
  let total: number | undefined;
  try {
    result = await itemPage(items, ast, filters, sort, page.limit, page.offset);
    if (wantCount) total = await itemCount(items, ast, filters);
  } catch (err) {
    // An AST-translation error (SearchAstError — e.g. an operator not valid for the field, or a
    // too-deep filter) is the caller's fault → 400.
    if (err instanceof SearchAstError) {
      return void sendError(res, 400, 'bad_request', err.message, { v1: true });
    }
    throw err;
  }

  // Resolve location names from one bounded read of the (physical, not 100k-row) tree,
  // rather than an N+1 lookup per row.
  const locationNames = await locationNameMap(driver);
  const data: readonly unknown[] =
    selection === undefined
      ? result.rows.map((item) => toItemSummary(item, locationNames.get(item.locationId) ?? null))
      : await Promise.all(
          result.rows.map((item) =>
            projectItem(
              createItemViewContext(driver, item, {
                locationName: locationNames.get(item.locationId) ?? null,
              }),
              selection,
            ),
          ),
        );
  sendList(res, data, page, result.hasMore, total);
}

/**
 * `GET /api/v1/items/$count` — the OData inline-count path: the grand total of matching items as
 * a bare `text/plain` integer, honouring the same `$filter`/`$search`/location/category scope.
 */
async function handleItemCount(res: ServerResponse, driver: Driver, url: URL): Promise<void> {
  const ast = parseItemFilterOr400(res, url);
  if (ast === null) return;

  const items = new ItemRepository(driver);
  const filters = readItemListFilters(url);
  try {
    sendText(res, 200, String(await itemCount(items, ast, filters)));
  } catch (err) {
    if (err instanceof SearchAstError) {
      return void sendError(res, 400, 'bad_request', err.message, { v1: true });
    }
    throw err;
  }
}

/**
 * `GET /api/v1/items.csv` — a spreadsheet-friendly CSV of the matching items (the same column
 * shape and RFC-4180 quoting as the app's own export, reused verbatim so the two never drift).
 * A refreshable pull for Excel/Power BI "From Web". Honours the same `$filter`/`$search`/
 * `$orderby`/location/category/includeInactive scope as `GET /api/v1/items`; unlike the JSON
 * list it returns **all** matching rows (up to {@link MAX_CSV_ROWS}), not a single page.
 */
async function handleItemsCsv(res: ServerResponse, driver: Driver, url: URL): Promise<void> {
  const sort = parseOrderByOr400(res, url);
  if (sort === null) return;
  const ast = parseItemFilterOr400(res, url);
  if (ast === null) return;

  const filters = readItemListFilters(url);
  try {
    const rows = await collectAllItems(driver, ast, filters, sort);
    sendCsv(res, 200, buildItemsCsv(rows), 'items.csv');
  } catch (err) {
    if (err instanceof SearchAstError) {
      return void sendError(res, 400, 'bad_request', err.message, { v1: true });
    }
    throw err;
  }
}

/**
 * Gather every matching item (for the CSV export) by looping the repository a page at a time,
 * stopping at {@link MAX_CSV_ROWS} so a huge dataset can't buffer unbounded. Uses the same
 * `$filter`-vs-`list` split as the JSON endpoint, so the CSV row set matches `GET /items`.
 */
async function collectAllItems(
  driver: Driver,
  ast: SearchAST | undefined,
  filters: ItemQueryFilters,
  sort: readonly ItemSort[] | undefined,
): Promise<readonly Item[]> {
  const items = new ItemRepository(driver);
  const rows: Item[] = [];
  for (let offset = 0; rows.length < MAX_CSV_ROWS; offset += MAX_PAGE_LIMIT) {
    const page = await itemPage(items, ast, filters, sort, MAX_PAGE_LIMIT, offset);
    rows.push(...page.rows);
    if (!page.hasMore) break;
  }
  return rows.length > MAX_CSV_ROWS ? rows.slice(0, MAX_CSV_ROWS) : rows;
}

/** The active-scope + non-page item list filters (location/category/$search), shared by rows + $count. */
type ItemQueryFilters = {
  locationId?: string;
  categoryId?: string;
  search?: string;
  includeInactive: boolean;
};

function readItemListFilters(url: URL): ItemQueryFilters {
  return {
    locationId: url.searchParams.get('location') ?? undefined,
    categoryId: url.searchParams.get('category') ?? undefined,
    // OData `$search` maps onto the app's FTS list filter.
    search: url.searchParams.get('$search') ?? undefined,
    includeInactive: url.searchParams.get('includeInactive') === 'true',
  };
}

/**
 * Fetch one page of items, single-sourcing the `$filter`-vs-`list` split every item query uses:
 * with a `$filter` the compiled `ast` is the **sole** row filter (location/category/$search are
 * ignored); without one, the plain `list` honours those scope filters. May throw
 * `SearchAstError` when the AST is invalid for a field — the caller maps that to a `400`.
 */
function itemPage(
  items: ItemRepository,
  ast: SearchAST | undefined,
  filters: ItemQueryFilters,
  sort: readonly ItemSort[] | undefined,
  limit: number,
  offset: number,
): Promise<Page<Item>> {
  return ast !== undefined
    ? items.searchByAst(ast, { limit, offset, includeInactive: filters.includeInactive, sort })
    : items.list({ ...filters, limit, offset, sort });
}

/** The `$count` twin of {@link itemPage}: the grand total under the same filter, no paging. */
function itemCount(
  items: ItemRepository,
  ast: SearchAST | undefined,
  filters: ItemQueryFilters,
): Promise<number> {
  return ast !== undefined
    ? items.countByAst(ast, { includeInactive: filters.includeInactive })
    : items.count(filters);
}

/**
 * Parse the optional `$filter` into a SearchAST, or send a `400` and return `null`. Returns
 * `undefined` when `$filter` is absent (use the plain `list` path). Only reports *syntax* errors
 * here (BadQueryError); an AST-translation error surfaces when the query runs.
 */
function parseItemFilterOr400(res: ServerResponse, url: URL): SearchAST | undefined | null {
  const raw = url.searchParams.get('$filter');
  if (raw === null) return undefined;
  try {
    return parseODataFilter(raw);
  } catch (err) {
    if (err instanceof BadQueryError) {
      sendError(res, 400, 'bad_request', err.message, { v1: true });
      return null;
    }
    throw err;
  }
}

async function handleItem(res: ServerResponse, driver: Driver, url: URL, id: string): Promise<void> {
  const raw = readSelection(url);
  if (hasSelection(raw)) {
    const selection = parseSelectionOr400(res, ITEM_DETAIL_DEFAULT_FIELDS, raw);
    if (selection === null) return;
    const item = await new ItemRepository(driver).getById(id);
    if (item === undefined) return notFound(res, 'item');
    return void sendJson(res, 200, await projectItem(createItemViewContext(driver, item), selection));
  }

  const detail = await loadItemDetail(driver, id);
  if (detail === null) return notFound(res, 'item');
  sendJson(res, 200, detail);
}

// --- locations --------------------------------------------------------------------

async function handleLocations(res: ServerResponse, driver: Driver, url: URL): Promise<void> {
  const page = readPage(url);
  const result = await new LocationRepository(driver).list({ limit: page.limit, offset: page.offset });
  sendList(res, result.rows.map(toLocation), page, result.hasMore);
}

async function handleLocation(res: ServerResponse, driver: Driver, id: string): Promise<void> {
  const location = await new LocationRepository(driver).getById(id);
  if (location === undefined) return notFound(res, 'location');
  // The live item count is the number of items whose home location is this one.
  const itemCount = await new ItemRepository(driver).count({ locationId: id });
  sendJson(res, 200, toLocation({ ...location, itemCount }));
}

// --- categories -------------------------------------------------------------------

async function handleCategories(res: ServerResponse, driver: Driver, url: URL): Promise<void> {
  const page = readPage(url);
  const result = await new CategoryRepository(driver).list({ limit: page.limit, offset: page.offset });
  sendList(res, result.rows.map(toCategorySummary), page, result.hasMore);
}

async function handleCategory(res: ServerResponse, driver: Driver, id: string): Promise<void> {
  const categories = new CategoryRepository(driver);
  const category = await categories.getById(id);
  if (category === undefined) return notFound(res, 'category');
  const fields = await categories.listFields(id);
  sendJson(res, 200, toCategoryDetail(category, fields));
}

// --- capabilities -----------------------------------------------------------------

async function handleCapabilities(res: ServerResponse, driver: Driver, url: URL): Promise<void> {
  const page = readPage(url);
  const result = await new ItemRepository(driver).listCapabilityKeys({
    limit: page.limit,
    offset: page.offset,
  });
  sendList(res, result.rows.map(toCapabilityKey), page, result.hasMore);
}

// --- helpers ----------------------------------------------------------------------

type Driver = BridgeServerState['driver'];

/**
 * Read the optional field-selection parameters off the query string, accepting both the plain
 * REST names (`fields`/`include`) and their OData aliases (`$select`/`$expand`, which win when
 * both are present).
 */
function readSelection(url: URL): RawSelection {
  const fields = readOption(url, '$select', 'fields');
  const include = readOption(url, '$expand', 'include');
  return {
    ...(fields !== null ? { fields } : {}),
    ...(include !== null ? { include } : {}),
  };
}

/**
 * Parse the optional `$orderby` into a validated sort spec, or send a `400` and return `null`.
 * Returns `undefined` when `$orderby` is absent (keep the endpoint's default ordering).
 */
function parseOrderByOr400(res: ServerResponse, url: URL): readonly ItemSort[] | undefined | null {
  const raw = url.searchParams.get('$orderby');
  if (raw === null) return undefined;
  try {
    return parseOrderBy(raw);
  } catch (err) {
    if (err instanceof BadQueryError) {
      sendError(res, 400, 'bad_request', err.message, { v1: true });
      return null;
    }
    throw err;
  }
}

/**
 * Parse a field selection, or send a `400 bad_request` (v1 envelope) and return `null` when it
 * is invalid. The `FieldSelectionError` message is caller-facing and PII-free by construction.
 */
function parseSelectionOr400(
  res: ServerResponse,
  defaults: readonly string[],
  raw: RawSelection,
): readonly SelectedField[] | null {
  try {
    return parseItemSelection(defaults, raw);
  } catch (err) {
    if (err instanceof FieldSelectionError) {
      sendError(res, 400, 'bad_request', err.message, { v1: true });
      return null;
    }
    throw err;
  }
}

function decode(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

function notFound(res: ServerResponse, resource: string): void {
  sendError(res, 404, 'not_found', `No such ${resource}`, { v1: true });
}

function sendList<T>(
  res: ServerResponse,
  data: readonly T[],
  page: PageRequest,
  hasMore: boolean,
  total?: number,
): void {
  const pagination: PaginationMeta = {
    limit: page.limit,
    offset: page.offset,
    count: data.length,
    hasMore,
    ...(total !== undefined ? { total } : {}),
  };
  const envelope: ListEnvelope<T> = { data, pagination };
  sendJson(res, 200, envelope);
}

/** A bounded id→name map of all locations (the physical hierarchy, not the item set). */
async function locationNameMap(driver: Driver): Promise<Map<string, string>> {
  const tree = await new LocationRepository(driver).getTree();
  const map = new Map<string, string>();
  const walk = (nodes: readonly LocationTreeNode[]): void => {
    for (const node of nodes) {
      map.set(node.id, node.name);
      walk(node.children);
    }
  };
  walk(tree);
  return map;
}
