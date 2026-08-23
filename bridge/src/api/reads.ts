/**
 * The **shared read engine** behind both JSON surfaces of the versioned API: the plain REST
 * endpoints (`/api/v1/items`, …) and the OData v4 service (`/api/v1/odata/items`, …).
 *
 * The two differ *only* in the envelope they wrap the result in — `{ data, pagination }` versus
 * `{ "@odata.context", "value", … }`. Everything that decides *which rows come back* — paging,
 * `$filter` compilation, `$orderby` validation, field selection, the location-name resolution —
 * lives here exactly once, so the two spellings of the same question can never drift into
 * different answers. Each `build*` function does the reading and projection and hands back the
 * rows plus the paging facts an envelope needs; the caller decides how to render them.
 *
 * The `…Or400` helpers keep the shared "validate, or answer and bail" shape: a `null` return
 * means a response has **already been written**, so the caller must simply return.
 */
import type { ServerResponse } from 'node:http';
import { ItemRepository } from '@/db/repositories/ItemRepository.ts';
import { LocationRepository } from '@/db/repositories/LocationRepository.ts';
import { CategoryRepository } from '@/db/repositories/CategoryRepository.ts';
import type { Item, LocationTreeNode, Page } from '@/db/repositories/types';
import type { ItemSort } from '@/db/repositories/item/sql.ts';
import type { SearchAST } from '@/db/search/ast.ts';
import { SearchAstError } from '@/db/search/parseASTtoSQL.ts';
import type { BridgeServerState } from '../server.ts';
import { loadItemDetail } from '../item-detail.ts';
import { sendError } from './respond.ts';
import { readPage, type PageRequest } from './params.ts';
import { BadQueryError, parseOrderBy, readOption } from './odata.ts';
import { parseODataFilter } from './odata-filter.ts';
import { FieldSelectionError, hasSelection, type RawSelection, type SelectedField } from './field-select.ts';
import {
  createItemViewContext,
  parseItemSelection,
  projectItem,
  ITEM_DETAIL_DEFAULT_FIELDS,
  ITEM_SUMMARY_DEFAULT_FIELDS,
} from './item-view.ts';
import { createLocationViewContext, parseLocationSelection, projectLocation } from './location-view.ts';
import { toCategoryDetail, toCategorySummary, toItemSummary, toLocation } from './dto.ts';

/** The snapshot driver every read runs against. */
export type Driver = BridgeServerState['driver'];

/** One page of projected rows, plus everything an envelope needs to describe the page. */
export interface ListResult {
  /** The projected rows, already in their public DTO / selected-field shape. */
  readonly rows: readonly unknown[];
  /** The effective (clamped) paging window this page came from. */
  readonly page: PageRequest;
  /** True when a further page may exist (a full page came back). */
  readonly hasMore: boolean;
  /** The grand total across all pages — present only when the caller asked for it (`$count=true`). */
  readonly total?: number;
  /**
   * The top-level field names the rows were projected to, when the caller supplied a
   * `fields`/`$select` selection. Absent for a default payload. The OData envelope needs it to
   * qualify its context URL (OData JSON §10.2 — a projected collection names its properties).
   */
  readonly selected?: readonly string[];
}

/**
 * The outcome of a single-resource read: the entity, a genuine miss, or "a response has already
 * been written" (an invalid selection answered with a `400`).
 */
export type EntityResult =
  | { readonly kind: 'ok'; readonly entity: unknown; readonly selected?: readonly string[] }
  | { readonly kind: 'missing' }
  | { readonly kind: 'handled' };

// --- items --------------------------------------------------------------------------

/**
 * Read one page of items under the caller's paging, sort, filter and field selection, projected
 * to either the default `ItemSummary` shape or the requested fields. Returns `null` when the
 * request was invalid and a `400` has already been sent.
 */
export async function buildItemList(
  res: ServerResponse,
  driver: Driver,
  url: URL,
): Promise<ListResult | null> {
  const page = readPage(url);
  const raw = readSelection(url);
  const selection = hasSelection(raw)
    ? parseSelectionOr400(res, ITEM_SUMMARY_DEFAULT_FIELDS, raw)
    : undefined;
  if (selection === null) return null; // a 400 was already sent

  const sort = parseOrderByOr400(res, url);
  if (sort === null) return null;

  const ast = parseItemFilterOr400(res, url);
  if (ast === null) return null; // an invalid $filter already sent a 400

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
      sendError(res, 400, 'bad_request', err.message, { v1: true });
      return null;
    }
    throw err;
  }

  // Resolve location names from one read of the (physical, not 100k-row) location tree, rather
  // than an N+1 lookup per row. Bounded by the hierarchy because it asks for nothing but the
  // rows: the tree read's volume aggregate — which walks the stock ledger — is opt-in, and this
  // path, which keeps only id and name, does not opt in (issue #525).
  const locationNames = await locationNameMap(driver);
  const rows: readonly unknown[] =
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

  return {
    rows,
    page,
    hasMore: result.hasMore,
    ...(total !== undefined ? { total } : {}),
    ...(selection !== undefined ? { selected: selection.map((field) => field.name) } : {}),
  };
}

/**
 * The grand total of items matching the caller's `$filter`/`$search`/location/category scope, or
 * `null` when the request was invalid and a `400` has already been sent.
 */
export async function buildItemCount(res: ServerResponse, driver: Driver, url: URL): Promise<number | null> {
  const ast = parseItemFilterOr400(res, url);
  if (ast === null) return null;

  try {
    return await itemCount(new ItemRepository(driver), ast, readItemListFilters(url));
  } catch (err) {
    if (err instanceof SearchAstError) {
      sendError(res, 400, 'bad_request', err.message, { v1: true });
      return null;
    }
    throw err;
  }
}

/** Read one item by id, projected to the requested fields (or the full `ItemDetail` shape). */
export async function buildItemEntity(
  res: ServerResponse,
  driver: Driver,
  url: URL,
  id: string,
): Promise<EntityResult> {
  const raw = readSelection(url);
  if (hasSelection(raw)) {
    const selection = parseSelectionOr400(res, ITEM_DETAIL_DEFAULT_FIELDS, raw);
    if (selection === null) return { kind: 'handled' };
    const item = await new ItemRepository(driver).getById(id);
    if (item === undefined) return { kind: 'missing' };
    return {
      kind: 'ok',
      entity: await projectItem(createItemViewContext(driver, item), selection),
      selected: selection.map((field) => field.name),
    };
  }

  const detail = await loadItemDetail(driver, id);
  if (detail === null) return { kind: 'missing' };
  return { kind: 'ok', entity: detail };
}

// --- locations ----------------------------------------------------------------------

/** Read one page of locations, projected to the requested fields (or the plain `Location` shape). */
export async function buildLocationList(
  res: ServerResponse,
  driver: Driver,
  url: URL,
): Promise<ListResult | null> {
  const page = readPage(url);
  const raw = readSelection(url);
  const result = await new LocationRepository(driver).list({ limit: page.limit, offset: page.offset });

  // Without a selection the response is the plain `LocationDto` it has always been; with one,
  // the same rows go through the shared field-selection engine (so `include=fields` adds the
  // location's custom-field values).
  if (!hasSelection(raw)) {
    return { rows: result.rows.map(toLocation), page, hasMore: result.hasMore };
  }
  const selection = parseLocationSelectionOr400(res, raw);
  if (selection === null) return null;
  const rows = await Promise.all(
    result.rows.map((location) => projectLocation(createLocationViewContext(driver, location), selection)),
  );
  return { rows, page, hasMore: result.hasMore, selected: selection.map((field) => field.name) };
}

/** Read one location by id, with its live item count, projected to the requested fields. */
export async function buildLocationEntity(
  res: ServerResponse,
  driver: Driver,
  url: URL,
  id: string,
): Promise<EntityResult> {
  const raw = readSelection(url);
  const selection = hasSelection(raw) ? parseLocationSelectionOr400(res, raw) : undefined;
  if (selection === null) return { kind: 'handled' };

  const location = await new LocationRepository(driver).getById(id);
  if (location === undefined) return { kind: 'missing' };
  // The live item count is the number of items whose home location is this one.
  const itemCount = await new ItemRepository(driver).count({ locationId: id });
  const row = { ...location, itemCount };

  if (selection === undefined) return { kind: 'ok', entity: toLocation(row) };
  return {
    kind: 'ok',
    entity: await projectLocation(createLocationViewContext(driver, row), selection),
    selected: selection.map((field) => field.name),
  };
}

// --- categories ---------------------------------------------------------------------

/** Read one page of categories with their field counts. */
export async function buildCategoryList(driver: Driver, url: URL): Promise<ListResult> {
  const page = readPage(url);
  const result = await new CategoryRepository(driver).list({ limit: page.limit, offset: page.offset });
  return { rows: result.rows.map(toCategorySummary), page, hasMore: result.hasMore };
}

/** Read one category by id, together with its custom-field schema. */
export async function buildCategoryEntity(driver: Driver, id: string): Promise<EntityResult> {
  const categories = new CategoryRepository(driver);
  const category = await categories.getById(id);
  if (category === undefined) return { kind: 'missing' };
  return { kind: 'ok', entity: toCategoryDetail(category, await categories.listFields(id)) };
}

// --- query-option parsing (shared by both envelopes) --------------------------------

/**
 * Read the optional field-selection parameters off the query string, accepting both the plain
 * REST names (`fields`/`include`) and their OData aliases (`$select`/`$expand`, which win when
 * both are present).
 */
export function readSelection(url: URL): RawSelection {
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
export function parseOrderByOr400(res: ServerResponse, url: URL): readonly ItemSort[] | undefined | null {
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
 * Parse the optional `$filter` into a SearchAST, or send a `400` and return `null`. Returns
 * `undefined` when `$filter` is absent (use the plain `list` path). Only reports *syntax* errors
 * here (BadQueryError); an AST-translation error surfaces when the query runs.
 */
export function parseItemFilterOr400(res: ServerResponse, url: URL): SearchAST | undefined | null {
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

/**
 * Parse a field selection, or send a `400 bad_request` (v1 envelope) and return `null` when it
 * is invalid. The `FieldSelectionError` message is caller-facing and PII-free by construction.
 */
export function parseSelectionOr400(
  res: ServerResponse,
  defaults: readonly string[],
  raw: RawSelection,
): readonly SelectedField[] | null {
  return selectionOr400(res, () => parseItemSelection(defaults, raw));
}

/** The location-vocabulary counterpart of {@link parseSelectionOr400}. */
export function parseLocationSelectionOr400(
  res: ServerResponse,
  raw: RawSelection,
): readonly SelectedField[] | null {
  return selectionOr400(res, () => parseLocationSelection(raw));
}

function selectionOr400(
  res: ServerResponse,
  parse: () => readonly SelectedField[],
): readonly SelectedField[] | null {
  try {
    return parse();
  } catch (err) {
    if (err instanceof FieldSelectionError) {
      sendError(res, 400, 'bad_request', err.message, { v1: true });
      return null;
    }
    throw err;
  }
}

// --- item query plumbing ------------------------------------------------------------

/** The active-scope + non-page item list filters (location/category/$search), shared by rows + $count. */
export type ItemQueryFilters = {
  locationId?: string;
  categoryId?: string;
  search?: string;
  includeInactive: boolean;
};

export function readItemListFilters(url: URL): ItemQueryFilters {
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
export function itemPage(
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
export function itemCount(
  items: ItemRepository,
  ast: SearchAST | undefined,
  filters: ItemQueryFilters,
): Promise<number> {
  return ast !== undefined
    ? items.countByAst(ast, { includeInactive: filters.includeInactive })
    : items.count(filters);
}

/**
 * A bounded id→name map of all locations (the physical hierarchy, not the item set).
 *
 * Bounded because the default tree read is: it joins `locations` to the trigger-maintained item
 * counter and stops there. Do not give this the volume aggregate (issue #525) — it would cost a
 * walk of `item_stock` per request to produce columns this map immediately throws away.
 */
export async function locationNameMap(driver: Driver): Promise<Map<string, string>> {
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
