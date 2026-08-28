/**
 * The Inventory screen's view state, expressed as `/inventory` URL search params (issue #574).
 *
 * Every axis the list filters on — the selected location, the quick search, the attention chips,
 * the category/tag facets, "Show removed" and the current page — used to live in component
 * `useState`, so a navigation away and back, a reload or a PWA update put the user back at
 * "everything, page 1". Moving them into the URL makes the address bar the single source of truth:
 * the view survives a reload, Back undoes the last narrowing, and a filtered list can be
 * bookmarked or shared.
 *
 * ## Why two shapes
 *
 * {@link InventorySearchParams} is what the URL carries — flat primitives only. The router
 * stringifies whatever the search object holds, and its default serialiser writes an array as
 * JSON (`?tags=%5B%22a%22%2C%22b%22%5D`), which is not a link anyone would want to send. So the
 * multi-value axes travel as comma-separated strings and this module owns both directions:
 * {@link decodeInventoryView} in, {@link encodeInventoryView} out.
 *
 * Defaults are **omitted** rather than written, so an untouched screen keeps a clean
 * `/inventory` and every param present in a URL means the user actually chose it.
 */
import { ITEM_STATUS_FILTERS, type ItemStatusFilter } from '@/db/repositories';

/**
 * The `/inventory` search params, exactly as they appear in the URL.
 *
 * `status` and `tags` are comma-separated lists; `removed` is only ever present as `true` (its
 * absence is the default); `page` is absent on page 1.
 */
export interface InventorySearchParams {
  readonly loc?: string;
  readonly q?: string;
  readonly status?: string;
  readonly cat?: string;
  readonly tags?: string;
  readonly removed?: true;
  readonly page?: number;
}

/** The decoded view state the screen works in. */
export interface InventoryView {
  readonly locationId: string | null;
  readonly search: string;
  readonly statuses: readonly ItemStatusFilter[];
  readonly categoryId: string | null;
  readonly tagIds: readonly string[];
  readonly includeInactive: boolean;
  /** 1-based. */
  readonly page: number;
}

/** The view an untouched `/inventory` shows. */
export const DEFAULT_INVENTORY_VIEW: InventoryView = {
  locationId: null,
  search: '',
  statuses: [],
  categoryId: null,
  tagIds: [],
  includeInactive: false,
  page: 1,
};

/** A search-param value the user typed, kept sane: a trimmed string, or `undefined`. */
function text(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
}

/** Split a comma-separated list param into its non-empty, de-duplicated members. */
function list(value: unknown): readonly string[] {
  const raw = text(value);
  if (raw === undefined) return [];
  return [
    ...new Set(
      raw
        .split(',')
        .map((part) => part.trim())
        .filter((part) => part !== ''),
    ),
  ];
}

/**
 * Validate a raw `/inventory` query string into {@link InventorySearchParams} (the route's
 * `validateSearch`).
 *
 * A URL is untrusted input — it can be hand-edited, stale from an older release, or simply
 * wrong — so anything unrecognised is dropped rather than thrown over: an unknown status token,
 * a non-numeric page, `removed=maybe`. The worst a bad link can do is show the default view.
 * Both list params are normalised here (canonical status order, sorted tag ids, no duplicates)
 * so two URLs meaning the same view are written the same way.
 */
export function parseInventorySearch(raw: Record<string, unknown>): InventorySearchParams {
  const chosen = list(raw.status);
  const statuses = ITEM_STATUS_FILTERS.filter((status) => chosen.includes(status));
  const tagIds = [...list(raw.tags)].sort();
  const loc = text(raw.loc);
  const q = text(raw.q);
  const cat = text(raw.cat);
  const page = Number(raw.page);
  return {
    ...(loc ? { loc } : {}),
    ...(q ? { q } : {}),
    ...(statuses.length > 0 ? { status: statuses.join(',') } : {}),
    ...(cat ? { cat } : {}),
    ...(tagIds.length > 0 ? { tags: tagIds.join(',') } : {}),
    ...(raw.removed === true || raw.removed === 'true' ? { removed: true as const } : {}),
    ...(Number.isFinite(page) && page > 1 ? { page: Math.floor(page) } : {}),
  };
}

/**
 * The status filters a `status` param names, in canonical order.
 *
 * Split out from {@link decodeInventoryView} so a caller can memoise it on that one param — the
 * array feeds an item query key, and re-deriving it whenever any *other* param moves (turning a
 * page, say) would invalidate every read for nothing.
 */
export function decodeStatusList(param: string | undefined): readonly ItemStatusFilter[] {
  const chosen = list(param);
  return ITEM_STATUS_FILTERS.filter((status) => chosen.includes(status));
}

/** The tag ids a `tags` param names, sorted. Memoisable on its own param, as above. */
export function decodeTagIdList(param: string | undefined): readonly string[] {
  return [...list(param)].sort();
}

/** Decode validated search params into the state the screen renders from. */
export function decodeInventoryView(params: InventorySearchParams): InventoryView {
  return {
    locationId: params.loc ?? null,
    search: params.q ?? '',
    statuses: decodeStatusList(params.status),
    categoryId: params.cat ?? null,
    tagIds: decodeTagIdList(params.tags),
    includeInactive: params.removed === true,
    page: params.page !== undefined && params.page > 1 ? Math.floor(params.page) : 1,
  };
}

/** Encode a view back into search params, omitting every axis that is at its default. */
export function encodeInventoryView(view: InventoryView): InventorySearchParams {
  const statuses = ITEM_STATUS_FILTERS.filter((status) => view.statuses.includes(status));
  const tagIds = [...new Set(view.tagIds)].sort();
  return {
    ...(view.locationId ? { loc: view.locationId } : {}),
    ...(view.search ? { q: view.search } : {}),
    ...(statuses.length > 0 ? { status: statuses.join(',') } : {}),
    ...(view.categoryId ? { cat: view.categoryId } : {}),
    ...(tagIds.length > 0 ? { tags: tagIds.join(',') } : {}),
    ...(view.includeInactive ? { removed: true as const } : {}),
    ...(view.page > 1 ? { page: Math.floor(view.page) } : {}),
  };
}

/**
 * Apply a change to the current view.
 *
 * Narrowing the list invalidates wherever the user had paged to — page 7 of an unfiltered list is
 * nothing like page 7 of a filtered one, and a narrowing filter can leave the page out of range
 * entirely — so **any** patch that touches a filter axis resets the page unless it names one
 * itself. A patch that changes only the page leaves every filter alone.
 */
export function applyInventoryViewPatch(view: InventoryView, patch: Partial<InventoryView>): InventoryView {
  const touchesFilters = Object.keys(patch).some((key) => key !== 'page');
  return { ...view, ...patch, page: patch.page ?? (touchesFilters ? 1 : view.page) };
}
