/**
 * The **item field vocabulary** — the single source of truth for every field the item query
 * API can project, and the lazy, memoised context that resolves them. It sits on top of the
 * generic {@link parseSelection}/{@link projectThrough} engine (`field-select.ts`) and is
 * shared verbatim by the HTTP `/api/v1` endpoints and the MCP tools, so both surfaces expose
 * exactly the same `fields`/`include` behaviour.
 *
 * Two tiers of field:
 *   - **default** — the fields already in each endpoint's baseline payload (search / list /
 *     detail). Naming these keeps today's shapes byte-identical.
 *   - **extended** — everything else the app already stores (owner's notes, pricing, lifecycle,
 *     reorder policy, operational metadata, the gauge, timestamps, and the relational
 *     `placements`/`capabilities`/`categoryName`). These are the "more information, if
 *     available" a caller opts into with `include` (or by naming in `fields`).
 *
 * Relational fields (`locationName`, `categoryName`, `placements`, `capabilities`) are resolved
 * **lazily and once** through the context, so a projection that doesn't select them never
 * incurs their extra read — and one that selects several sharing a source reads it a single time.
 */
import { ItemRepository } from '@/db/repositories/ItemRepository.ts';
import { LocationRepository } from '@/db/repositories/LocationRepository.ts';
import { CategoryRepository } from '@/db/repositories/CategoryRepository.ts';
import type { IDatabaseDriver } from '@/db/rpc/driver';
import type { Item } from '@/db/repositories/types';
import { toCapability, type CapabilityDto, type PlacementDto } from './dto.ts';
import {
  parseSelection,
  projectThrough,
  type FieldNode,
  type FieldRegistry,
  type RawSelection,
  type SelectedField,
} from './field-select.ts';

/**
 * The lazily-resolved view of one item: the base row (always present) plus memoised accessors
 * for its relational data. Each accessor caches its promise, so repeated selection of a field
 * (or several fields sharing a source) reads at most once.
 */
export interface ItemViewContext {
  readonly item: Item;
  locationName(): Promise<string | null>;
  categoryName(): Promise<string | null>;
  placements(): Promise<readonly PlacementDto[]>;
  capabilities(): Promise<readonly CapabilityDto[]>;
}

/**
 * Build an {@link ItemViewContext} over a driver + already-loaded item row. Pass a
 * `locationName` (e.g. from a bulk name map on a list endpoint) to avoid an N+1 lookup;
 * otherwise it is resolved lazily by id on first access.
 */
export function createItemViewContext(
  driver: IDatabaseDriver,
  item: Item,
  opts: { readonly locationName?: string | null } = {},
): ItemViewContext {
  const items = new ItemRepository(driver);

  let locationNameP: Promise<string | null> | undefined =
    'locationName' in opts ? Promise.resolve(opts.locationName ?? null) : undefined;
  let categoryNameP: Promise<string | null> | undefined;
  let placementsP: Promise<readonly PlacementDto[]> | undefined;
  let capabilitiesP: Promise<readonly CapabilityDto[]> | undefined;

  return {
    item,
    locationName() {
      return (locationNameP ??= (async () =>
        (await new LocationRepository(driver).getById(item.locationId))?.name ?? null)());
    },
    categoryName() {
      return (categoryNameP ??= (async () =>
        item.categoryId === null
          ? null
          : ((await new CategoryRepository(driver).getById(item.categoryId))?.name ?? null))());
    },
    placements() {
      return (placementsP ??= (async () =>
        (await items.listStock(item.id)).map((p) => ({
          locationId: p.locationId,
          locationName: p.locationName,
          quantity: p.quantity,
        })))());
    },
    capabilities() {
      return (capabilitiesP ??= (async () => (await items.listCapabilities(item.id)).map(toCapability))());
    },
  };
}

/** Element sub-keys for the two nested (array-of-object) fields — kept in sync with the DTOs. */
const PLACEMENT_KEYS = ['locationId', 'locationName', 'quantity'] as const;
const CAPABILITY_KEYS = ['key', 'valueNum', 'valueText', 'weight'] as const;

/**
 * The complete item field registry, in the order fields appear in a projected response. Every
 * exposable field lives here exactly once; the endpoint default sets and include aliases below
 * are just curated name lists over these keys.
 */
const ITEM_FIELDS: readonly (readonly [string, FieldNode<ItemViewContext>])[] = [
  // Identity + core summary (the search/list defaults).
  ['id', { resolve: (c) => c.item.id }],
  ['name', { resolve: (c) => c.item.name }],
  ['quantity', { resolve: (c) => c.item.quantity }],
  ['locationId', { resolve: (c) => c.item.locationId }],
  ['locationName', { resolve: (c) => c.locationName() }],
  ['categoryId', { resolve: (c) => c.item.categoryId }],
  ['categoryName', { resolve: (c) => c.categoryName() }],
  ['mpn', { resolve: (c) => c.item.mpn }],
  ['manufacturer', { resolve: (c) => c.item.manufacturer }],
  ['trackingMode', { resolve: (c) => c.item.trackingMode }],
  ['isActive', { resolve: (c) => c.item.isActive }],
  // Descriptive / detail.
  ['description', { resolve: (c) => c.item.description }],
  ['notes', { resolve: (c) => c.item.notes }],
  ['condition', { resolve: (c) => c.item.condition }],
  ['serialNo', { resolve: (c) => c.item.serialNo }],
  ['parentId', { resolve: (c) => c.item.parentId }],
  // Pricing.
  ['unitCost', { resolve: (c) => c.item.unitCost }],
  ['purchasePrice', { resolve: (c) => c.item.purchasePrice }],
  // Perishable / traceability.
  ['expiryDate', { resolve: (c) => c.item.expiryDate }],
  ['batchNumber', { resolve: (c) => c.item.batchNumber }],
  ['lotNumber', { resolve: (c) => c.item.lotNumber }],
  // Asset lifecycle.
  ['acquiredAt', { resolve: (c) => c.item.acquiredAt }],
  ['warrantyExpiresAt', { resolve: (c) => c.item.warrantyExpiresAt }],
  ['depreciationMonths', { resolve: (c) => c.item.depreciationMonths }],
  // Reorder policy.
  ['reorderPoint', { resolve: (c) => c.item.reorderPoint }],
  ['reorderGaugePercent', { resolve: (c) => c.item.reorderGaugePercent }],
  ['reorderQty', { resolve: (c) => c.item.reorderQty }],
  // Flexible metadata + the derived gauge state.
  ['operationalMetadata', { resolve: (c) => c.item.operationalMetadata }],
  ['gauge', { resolve: (c) => c.item.gauge }],
  // Timestamps.
  ['createdAt', { resolve: (c) => c.item.createdAt }],
  ['updatedAt', { resolve: (c) => c.item.updatedAt }],
  // Relations (nested, array-of-object).
  ['placements', { resolve: (c) => c.placements(), elementKeys: PLACEMENT_KEYS }],
  ['capabilities', { resolve: (c) => c.capabilities(), elementKeys: CAPABILITY_KEYS }],
];

/** The item field registry as a lookup map (iteration order preserved from {@link ITEM_FIELDS}). */
export const ITEM_FIELD_REGISTRY: FieldRegistry<ItemViewContext> = new Map(ITEM_FIELDS);

/** The default field set of `GET /api/v1/search` matches — the compact `ItemMatch` shape. */
export const SEARCH_DEFAULT_FIELDS: readonly string[] = [
  'id',
  'name',
  'quantity',
  'locationName',
  'mpn',
  'manufacturer',
];

/** The default field set of `GET /api/v1/items` rows — the `ItemSummary` shape. */
export const ITEM_SUMMARY_DEFAULT_FIELDS: readonly string[] = [
  'id',
  'name',
  'quantity',
  'locationId',
  'locationName',
  'categoryId',
  'mpn',
  'manufacturer',
  'trackingMode',
  'isActive',
];

/** The default field set of `GET /api/v1/items/{id}` — the full `ItemDetail` shape. */
export const ITEM_DETAIL_DEFAULT_FIELDS: readonly string[] = [
  ...ITEM_SUMMARY_DEFAULT_FIELDS,
  'description',
  'categoryName',
  'unitCost',
  'condition',
  'serialNo',
  'parentId',
  'expiryDate',
  'batchNumber',
  'lotNumber',
  'createdAt',
  'updatedAt',
  'placements',
  'capabilities',
];

/**
 * Named field groups a caller may use in `include`, for ergonomics — e.g. `include=relations`
 * pulls in placements, capabilities and the category name in one go. `all` expands to the
 * entire vocabulary.
 */
export const ITEM_INCLUDE_ALIASES: Readonly<Record<string, readonly string[]>> = {
  relations: ['placements', 'capabilities', 'categoryName'],
  pricing: ['unitCost', 'purchasePrice'],
  lifecycle: ['acquiredAt', 'warrantyExpiresAt', 'purchasePrice', 'depreciationMonths'],
  reorder: ['reorderPoint', 'reorderGaugePercent', 'reorderQty'],
  timestamps: ['createdAt', 'updatedAt'],
  all: [...ITEM_FIELD_REGISTRY.keys()],
};

/** Parse a raw item selection against the item registry, defaulting to `defaults` when `fields` is absent. */
export function parseItemSelection(defaults: readonly string[], raw: RawSelection): readonly SelectedField[] {
  return parseSelection({ registry: ITEM_FIELD_REGISTRY, defaults, aliases: ITEM_INCLUDE_ALIASES }, raw);
}

/** Project one item view through a resolved selection. */
export function projectItem(
  ctx: ItemViewContext,
  selection: readonly SelectedField[],
): Promise<Record<string, unknown>> {
  return projectThrough(ITEM_FIELD_REGISTRY, selection, ctx);
}
