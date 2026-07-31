/**
 * Pure mapping between raw SQLite rows and the camelCase domain objects.
 * SQLite STRICT stores booleans as 0/1 integers and JSON blobs as TEXT; mapping
 * is centralised here so every read returns consistently shaped, typed domain data.
 */
import { fromStoredMoney } from '@/lib/money';
import { currentGrossWeight, percentageRemaining } from './gauge';
import type {
  ApiToken,
  ApiTokenRow,
  Role,
  RoleRow,
  User,
  UserRow,
  Capability,
  CapabilityRow,
  AssetBooking,
  AssetBookingRow,
  Checkout,
  CheckoutRow,
  Contact,
  ContactRow,
  Category,
  CategoryField,
  CategoryFieldRow,
  CategoryLookupSource,
  CategoryRow,
  FieldDef,
  FieldDefRow,
  FieldDueDate,
  FieldDueDateRow,
  GaugeState,
  LocationFieldValue,
  LocationFieldValueRow,
  LocationHistoryEntry,
  LocationHistoryRow,
  Item,
  ItemAlias,
  ItemAliasRow,
  ItemAttachment,
  ItemAttachmentRow,
  ActivityFeedEntry,
  ActivityFeedRow,
  ItemHistoryEntry,
  ItemHistoryRow,
  ItemImage,
  ItemImageRow,
  LocationPhoto,
  LocationPhotoRow,
  LocationRegion,
  LocationRegionRow,
  ItemRow,
  Location,
  LocationRow,
  MaintenanceSchedule,
  MaintenanceScheduleRow,
  Project,
  ProjectBomLine,
  ProjectBomLineRow,
  ProjectBudgetCategory,
  ProjectBudgetCategoryRow,
  ProjectExpense,
  ProjectExpenseRow,
  ProjectRow,
  PriceBreak,
  PurchaseOrder,
  PurchaseOrderLine,
  PurchaseOrderLineRow,
  PurchaseOrderRow,
  SupplierPart,
  Supplier,
  SupplierPartRow,
  SupplierRow,
  SupplierPartPriceHistoryEntry,
  SupplierPartPriceHistoryRow,
  Revaluation,
  RevaluationRow,
  ItemRelation,
  ItemRelationRow,
  ItemRelationView,
  TestRecord,
  TestRecordRow,
  SavedTarePreset,
  TarePresetRow,
  Tag,
  TagRow,
  WishlistEntry,
  WishlistRow,
  WebhookRow,
  WebhookSubscription,
} from './types';
import type { BorrowerType, FieldType } from './constants';
import type { RelationKind } from '@/features/inventory/item-relations';
import { normaliseTarePresetKind } from '@/features/inventory/tare-presets';
import { normaliseTestRecordKind, normaliseTestResult } from '@/features/inventory/test-records';
import { normaliseWishlistPriority } from '@/features/purchasing/wishlist';
import { parseWebhookFilter } from '@/features/webhooks/filter';
import { normaliseWebhookMethod } from '@/features/webhooks/subscription';

function parseJson(value: string | null): Record<string, unknown> | null {
  if (value == null) return null;
  try {
    const parsed = JSON.parse(value);
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export function rowToLocation(row: LocationRow): Location {
  return {
    id: row.id,
    name: row.name,
    parentId: row.parent_id,
    isSystem: row.is_system === 1,
    description: row.description,
    color: row.color,
    kind: row.kind,
    capacity: row.capacity,
    isDefault: row.is_default === 1,
    archivedAt: row.archived_at,
    lastCountedAt: row.last_counted_at,
    deadStockMode: row.dead_stock_mode,
    deadStockDays: row.dead_stock_days,
    // Canonical mm / mm³ REAL columns are already `number | null` off the driver — pass through
    // uncoerced, exactly as the item mapper does for width/height/depth (issue #457).
    width: row.width,
    height: row.height,
    depth: row.depth,
    usableVolume: row.usable_volume,
    packingFactor: row.packing_factor,
    // Walk-order ordinal (issue #461) is an INTEGER column, already `number | null` off the
    // driver — pass through uncoerced like the dimension columns above.
    walkOrder: row.walk_order,
    updatedAt: row.updated_at,
  };
}

export function rowToItem(row: ItemRow): Item {
  const isGauge =
    row.tracking_mode === 'CONSUMABLE_GAUGE' &&
    row.unit_of_measure != null &&
    row.gross_capacity != null &&
    row.current_net_value != null;

  let gauge: GaugeState | null = null;
  if (isGauge) {
    const tare = row.tare_weight ?? 0;
    const net = row.current_net_value;
    const gross = row.gross_capacity;
    gauge = {
      unitOfMeasure: row.unit_of_measure,
      grossCapacity: gross,
      tareWeight: tare,
      currentNetValue: net,
      percentageRemaining: percentageRemaining(net, gross),
      currentGrossWeight: currentGrossWeight(net, tare),
      attritionPercent: row.attrition_percent,
      // Money column: stored as integer micro-units (issue #286), major units in the app.
      costPerUnitOfMeasure: fromStoredMoney(row.cost_per_unit_of_measure),
    };
  }

  return {
    id: row.id,
    name: row.name,
    description: row.description,
    notes: row.notes,
    locationId: row.location_id,
    categoryId: row.category_id,
    trackingMode: row.tracking_mode,
    quantity: row.quantity,
    serialNo: row.serial_no,
    mpn: row.mpn,
    manufacturer: row.manufacturer,
    barcode: row.barcode,
    serialNumber: row.serial_number,
    // Money columns are stored as integer micro-units (issue #286); the app works in major units.
    unitCost: fromStoredMoney(row.unit_cost),
    expiryDate: row.expiry_date,
    batchNumber: row.batch_number,
    lotNumber: row.lot_number,
    condition: row.condition,
    parentId: row.parent_id,
    // Derived per read via `HAS_VARIANTS_SUBQUERY` — an abstract variant parent holds no stock
    // of its own, so the pure reorder seam excludes it exactly as the SQL does (issue #156).
    hasVariants: row.has_variants === 1,
    // "Unlimited supply" modifier (Phase 82); DISCRETE-only infinite source.
    isUnlimited: row.is_unlimited === 1,
    // "Favourite" pin (issue #23): starred items sort ahead of the rest of the list.
    isFavourite: row.is_favourite === 1,
    deadStockMode: row.dead_stock_mode,
    // Per-item reorder policy (Phase 59); null = fall back to the global default.
    reorderPoint: row.reorder_point,
    reorderGaugePercent: row.reorder_gauge_percent,
    reorderQty: row.reorder_qty,
    // Asset lifecycle facet (Phase 66, v24); all null for pre-v24 items (additive).
    acquiredAt: row.acquired_at,
    warrantyExpiresAt: row.warranty_expires_at,
    purchasePrice: fromStoredMoney(row.purchase_price),
    depreciationMonths: row.depreciation_months,
    // Intrinsic mass in canonical grams (issue #25); null when no weight is recorded.
    weight: row.weight,
    // Intrinsic bounding-box dimensions in canonical millimetres (issue #30); null when unset.
    width: row.width,
    height: row.height,
    depth: row.depth,
    // Manual current / market value (feature-gap G9, v4); null for items never revalued.
    currentValue: fromStoredMoney(row.current_value),
    isActive: row.is_active === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    gauge,
    // §4.1.1 schema-less operational parameters — present on any item, not just gauges.
    operationalMetadata: parseJson(row.operational_metadata),
    // Only populated by reads that JOIN item_images (§4.2.4); never the full-res path.
    thumbnailBlob: 'thumbnail_blob' in row ? (row.thumbnail_blob ?? null) : undefined,
  };
}

/**
 * Parse a `supplier_parts.price_breaks` JSON column into a clean, ascending `PriceBreak[]`.
 * Defensive: any malformed entry (non-object, non-finite/negative numbers) is dropped rather
 * than surfaced, so a corrupt or future-shaped value never reaches the UI as `NaN`.
 */
export function parsePriceBreaks(value: string | null): PriceBreak[] {
  if (value == null) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const breaks: PriceBreak[] = [];
  for (const entry of parsed) {
    if (typeof entry !== 'object' || entry === null) continue;
    const { qty, unitCost } = entry as Record<string, unknown>;
    if (typeof qty !== 'number' || typeof unitCost !== 'number') continue;
    if (!Number.isFinite(qty) || !Number.isFinite(unitCost) || qty <= 0 || unitCost < 0) continue;
    breaks.push({ qty, unitCost });
  }
  return breaks.sort((a, b) => a.qty - b.qty);
}

export function rowToSupplierPart(row: SupplierPartRow): SupplierPart {
  return {
    id: row.id,
    itemId: row.item_id,
    supplierId: row.supplier_id,
    supplierName: row.supplier_name,
    orderCode: row.order_code,
    unitCost: fromStoredMoney(row.unit_cost),
    currency: row.currency,
    packQty: row.pack_qty,
    minOrderQty: row.min_order_qty,
    priceBreaks: parsePriceBreaks(row.price_breaks),
    url: row.url,
    isPreferred: row.is_preferred === 1,
    isPriceSource: row.is_price_source === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function rowToSupplierPartPriceHistory(
  row: SupplierPartPriceHistoryRow,
): SupplierPartPriceHistoryEntry {
  return {
    id: row.id,
    supplierPartId: row.supplier_part_id,
    unitCost: fromStoredMoney(row.unit_cost),
    currency: row.currency,
    source: row.source,
    recordedAt: row.recorded_at,
    updatedAt: row.updated_at,
  };
}

export function rowToRevaluation(row: RevaluationRow): Revaluation {
  return {
    id: row.id,
    itemId: row.item_id,
    value: fromStoredMoney(row.value),
    revaluedAt: row.revalued_at,
    note: row.note,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * Map a raw wishlist row (feature-gap G8). `priority` is normalised through the seam (the DB has
 * no CHECK on it, so a stale/unknown value softens to `NONE` rather than leaking out untyped).
 */
export function rowToWishlistEntry(row: WishlistRow): WishlistEntry {
  return {
    id: row.id,
    name: row.name,
    note: row.note,
    url: row.url,
    targetPrice: fromStoredMoney(row.target_price),
    priority: normaliseWishlistPriority(row.priority),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * Map a raw saved tare-preset row (issue #94). `kind` is normalised through the seam (the DB
 * has no CHECK on it, so a stale/unknown value softens to `OTHER` rather than leaking out
 * untyped), exactly like `rowToWishlistEntry`'s priority.
 */
export function rowToSavedTarePreset(row: TarePresetRow): SavedTarePreset {
  return {
    id: row.id,
    name: row.name,
    brand: row.brand,
    kind: normaliseTarePresetKind(row.kind),
    tareGrams: row.tare_grams,
    note: row.note,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * Parse a JSON **object** column, rejecting anything that is not a plain object — including an
 * array, which {@link parseJson} would otherwise wave through as a `Record` (arrays are objects
 * to `typeof`) and hand to a caller expecting named keys.
 */
function parseJsonObject(value: string | null): Record<string, unknown> | null {
  const parsed = parseJson(value);
  return parsed !== null && !Array.isArray(parsed) ? parsed : null;
}

/**
 * Map a raw webhook-subscription row (issue #87). The three JSON columns are parsed here so a
 * caller only ever sees typed values, and each one softens independently on malformed input
 * rather than throwing: these rows arrive over sync from peers that may be running a newer (or
 * older) build, and one bad field must not fail the whole read — or, worse, abort a sync apply
 * mid-batch.
 *
 * `event_types` softens to `[]` and `enabled` is read strictly (`=== 1`), which together make a
 * corrupt row **inert** rather than over-firing: a subscription that cannot say what it wants
 * matches nothing, which is the safe direction for something that calls out to the network.
 * `method` goes through the seam like `rowToWishlistEntry`'s priority, though the DB CHECK means
 * it should never need to.
 *
 * `headers` upholds the seam's "empty means none" invariant on the way *out* as well as in: a
 * stored `{}` — or an object whose every value was dropped as non-text — reads back as `null`,
 * not as a truthy empty object, so a caller can test `headers` for presence without also having
 * to count its keys.
 */
export function rowToWebhookSubscription(row: WebhookRow): WebhookSubscription {
  const eventTypes = parseJson(row.event_types);
  const headers = parseJsonObject(row.headers);
  const textHeaders =
    headers === null
      ? null
      : Object.fromEntries(
          Object.entries(headers).filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
        );
  return {
    id: row.id,
    name: row.name,
    url: row.url,
    method: normaliseWebhookMethod(row.method),
    enabled: row.enabled === 1,
    secret: row.secret,
    secretRef: row.secret_ref,
    eventTypes: Array.isArray(eventTypes) ? eventTypes.filter((t): t is string => typeof t === 'string') : [],
    filter: parseWebhookFilter(parseJsonObject(row.filter)),
    headers: textHeaders !== null && Object.keys(textHeaders).length > 0 ? textHeaders : null,
    template: row.template,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * Map a raw item-relation row (feature-gap G6). `kind` is preserved verbatim (cast to
 * {@link RelationKind}) rather than validated here: the DB has no CHECK, so a kind minted by a
 * newer peer round-trips intact, and the display seam (`describeItemRelations`) filters any the
 * running build doesn't understand.
 */
export function rowToItemRelation(row: ItemRelationRow): ItemRelation {
  return {
    id: row.id,
    fromItemId: row.from_item_id,
    toItemId: row.to_item_id,
    kind: row.kind as RelationKind,
    note: row.note,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** A relation row joined with the other item's display fields (see {@link ItemRelationView}). */
interface ItemRelationViewRow extends ItemRelationRow {
  readonly other_item_id: string;
  readonly other_item_name: string;
  readonly other_item_serial_no: number | null;
}

/** Map a joined relation row into the {@link ItemRelationView} the item-detail surface renders. */
export function rowToItemRelationView(row: ItemRelationViewRow): ItemRelationView {
  return {
    ...rowToItemRelation(row),
    otherItemId: row.other_item_id,
    otherItemName: row.other_item_name,
    otherItemSerialNo: row.other_item_serial_no,
  };
}

/**
 * Map a raw test-record row (feature-gap G7). `kind`/`result` are normalised through the seam (the
 * DB has no CHECK on either, so a stale/unknown value softens to its default rather than leaking out
 * untyped), exactly like `rowToWishlistEntry`'s priority.
 */
export function rowToTestRecord(row: TestRecordRow): TestRecord {
  return {
    id: row.id,
    itemId: row.item_id,
    kind: normaliseTestRecordKind(row.kind),
    name: row.name,
    result: normaliseTestResult(row.result),
    reading: row.reading,
    unit: row.unit,
    note: row.note,
    performedAt: row.performed_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function rowToSupplier(row: SupplierRow): Supplier {
  return {
    id: row.id,
    name: row.name,
    url: row.url,
    currency: row.currency,
    note: row.note,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function rowToPurchaseOrder(row: PurchaseOrderRow): PurchaseOrder {
  return {
    id: row.id,
    supplierId: row.supplier_id,
    supplierName: row.supplier_name,
    reference: row.reference,
    status: row.status,
    currency: row.currency,
    createdAt: row.created_at,
    orderedAt: row.ordered_at,
    updatedAt: row.updated_at,
  };
}

export function rowToPurchaseOrderLine(row: PurchaseOrderLineRow): PurchaseOrderLine {
  return {
    id: row.id,
    poId: row.po_id,
    itemId: row.item_id,
    supplierPartId: row.supplier_part_id,
    description: row.description,
    orderedQty: Number(row.ordered_qty),
    receivedQty: Number(row.received_qty),
    unitCost: fromStoredMoney(row.unit_cost),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function rowToHistoryEntry(row: ItemHistoryRow): ItemHistoryEntry {
  return {
    id: row.id,
    itemId: row.item_id,
    action: row.action,
    quantityDelta: row.quantity_delta,
    netValueDelta: row.net_value_delta,
    note: row.note,
    metadata: parseJson(row.metadata),
    createdAt: row.created_at,
  };
}

/** Map a raw `location_history` row to its DTO (issue #691). */
export function rowToLocationHistoryEntry(row: LocationHistoryRow): LocationHistoryEntry {
  return {
    id: row.id,
    locationId: row.location_id,
    locationName: row.location_name,
    action: row.action,
    note: row.note,
    metadata: parseJson(row.metadata),
    actorUserId: row.actor_user_id,
    createdAt: row.created_at,
  };
}

/** Compose a joined activity-feed row (history + owning item name/state). */
export function rowToActivityFeedEntry(row: ActivityFeedRow): ActivityFeedEntry {
  return {
    ...rowToHistoryEntry(row),
    itemName: row.item_name,
    itemIsActive: row.item_is_active === 1,
  };
}

/**
 * Parse the `categories.hidden_capabilities` JSON array (issue #618).
 *
 * Softens rather than throws — a malformed or non-array payload from a peer costs this one
 * field, not the whole sync apply. Unlike {@link parseStringArray} it *drops* non-string
 * members instead of coercing them, so a stray `null` can't round-trip back to storage as
 * the literal id `"null"`. Ids this build doesn't recognise are kept deliberately: a newer
 * peer may hide a capability that doesn't exist here yet.
 */
function parseHiddenCapabilities(value: string | null): readonly string[] {
  if (value == null) return [];
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : [];
  } catch {
    return [];
  }
}

/**
 * Read one member of the `categories.lookup_sources` array, or `null` when it isn't one.
 *
 * A member is usable only if it carries a non-blank `providerId`, since that id *is* the
 * entry — an entry without one names no provider and could never be resolved or written back
 * meaningfully. Everything else is salvaged rather than required: a `fieldMap` that isn't an
 * object of string→string entries is dropped down to "bind by name", which is exactly what an
 * absent map means, rather than discarding the whole entry over its optional half.
 */
function parseLookupSourceEntry(member: unknown): CategoryLookupSource | null {
  if (typeof member !== 'object' || member === null || Array.isArray(member)) return null;
  const raw = member as { providerId?: unknown; fieldMap?: unknown };
  const providerId = typeof raw.providerId === 'string' ? raw.providerId.trim() : '';
  // Trimmed on the way in, not merely validated: a peer that wrote `"wikidata-film "` would
  // otherwise round-trip verbatim and then silently fail to resolve against the registry, so a
  // provider this build *does* have would quietly offer no lookup.
  if (providerId.length === 0) return null;

  let fieldMap: Record<string, string> | null = null;
  if (typeof raw.fieldMap === 'object' && raw.fieldMap !== null && !Array.isArray(raw.fieldMap)) {
    const pairs = Object.entries(raw.fieldMap as Record<string, unknown>).filter(
      (pair): pair is [string, string] => typeof pair[1] === 'string' && pair[1].length > 0,
    );
    if (pairs.length > 0) fieldMap = Object.fromEntries(pairs);
  }
  return { providerId, fieldMap };
}

/**
 * Parse the `categories.lookup_sources` JSON array (issue #616).
 *
 * Softens rather than throws, exactly as {@link parseHiddenCapabilities} does and for the same
 * reason — a malformed payload from a peer costs this one field, not the whole sync apply.
 * Provider ids this build doesn't recognise are kept deliberately: resolving an id against the
 * registry is the feature layer's job, so a newer peer's choice survives a round-trip through
 * this device. Entries are de-duplicated by `providerId`, first occurrence winning, because
 * running the same provider twice against one category is meaningless.
 */
function parseLookupSources(value: string | null): readonly CategoryLookupSource[] {
  if (value == null) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const seen = new Set<string>();
  const entries: CategoryLookupSource[] = [];
  for (const member of parsed) {
    const entry = parseLookupSourceEntry(member);
    if (entry === null || seen.has(entry.providerId)) continue;
    seen.add(entry.providerId);
    entries.push(entry);
  }
  return entries;
}

export function rowToCategory(row: CategoryRow): Category {
  return {
    id: row.id,
    name: row.name,
    glyph: row.glyph,
    defaultTrackingMode: row.default_tracking_mode,
    defaultCondition: row.default_condition,
    defaultWarrantyMonths: row.default_warranty_months,
    defaultMaintenanceBasis: row.default_maintenance_basis,
    defaultMaintenanceIntervalDays: row.default_maintenance_interval_days,
    defaultMaintenanceIntervalUsage: row.default_maintenance_interval_usage,
    hiddenCapabilities: parseHiddenCapabilities(row.hidden_capabilities),
    lookupSources: parseLookupSources(row.lookup_sources),
    fieldProminence: row.field_prominence,
    fieldTabLabel: row.field_tab_label,
    updatedAt: row.updated_at,
  };
}

function parseStringArray(value: string | null): string[] | null {
  if (value == null) return null;
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.map((v) => String(v)) : null;
  } catch {
    return null;
  }
}

export function rowToCategoryField(row: CategoryFieldRow): CategoryField {
  return {
    id: row.id,
    categoryId: row.category_id,
    defId: row.def_id,
    name: row.name,
    fieldType: row.field_type,
    options: parseStringArray(row.options),
    isRequired: row.is_required === 1,
    defaultValue: row.default_value,
    description: row.description,
    dueLeadDays: row.due_lead_days,
    unit: row.unit,
    minValue: row.min_value,
    maxValue: row.max_value,
    prominence: row.prominence,
    position: row.position,
    updatedAt: row.updated_at,
  };
}

/** A global field-dictionary definition row (issue #97) as a DTO. */
export function rowToFieldDef(row: FieldDefRow): FieldDef {
  return {
    id: row.id,
    name: row.name,
    fieldType: row.field_type,
    options: parseStringArray(row.options),
    description: row.description,
    dueLeadDays: row.due_lead_days,
    unit: row.unit,
    minValue: row.min_value,
    maxValue: row.max_value,
    prominence: row.prominence,
    updatedAt: row.updated_at,
  };
}

/**
 * One opted-in custom-field due date (W1a) as a DTO.
 *
 * `value` is the stored `YYYY-MM-DD`, which the query has already shape-checked and validated
 * as a real calendar day — so `Date.parse` is total here, and yields the midnight-UTC instant
 * that every day-grained value in the app is anchored at (issue #320).
 */
export function rowToFieldDueDate(row: FieldDueDateRow): FieldDueDate {
  return {
    itemId: row.item_id,
    itemName: row.item_name,
    defId: row.def_id,
    fieldName: row.field_name,
    leadDays: row.due_lead_days,
    dueAt: Date.parse(row.value),
  };
}

/**
 * A location's value for a definition, joined to that definition (issue #97). The
 * join columns are read alongside the value row so callers get one flat field.
 */
export function rowToLocationFieldValue(
  row: LocationFieldValueRow & {
    readonly name: string;
    readonly field_type: FieldType;
    readonly options: string | null;
    readonly description: string | null;
    readonly unit: string | null;
    readonly min_value: number | null;
    readonly max_value: number | null;
    readonly prominence: string | null;
  },
): LocationFieldValue {
  return {
    id: row.id,
    locationId: row.location_id,
    defId: row.def_id,
    name: row.name,
    fieldType: row.field_type,
    options: parseStringArray(row.options),
    description: row.description,
    unit: row.unit,
    minValue: row.min_value,
    maxValue: row.max_value,
    prominence: row.prominence,
    value: row.value,
    isInheritable: row.is_inheritable === 1,
    updatedAt: row.updated_at,
  };
}

export function rowToTag(row: TagRow): Tag {
  return { id: row.id, name: row.name, updatedAt: row.updated_at };
}

export function rowToItemImage(row: ItemImageRow): ItemImage {
  return {
    id: row.id,
    itemId: row.item_id,
    thumbnailBlob: row.thumbnail_blob ?? null,
    fullResOpfsPath: row.full_res_opfs_path,
    position: row.position,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    fullResDowngradedAt: row.full_res_downgraded_at ?? null,
  };
}

export function rowToLocationPhoto(row: LocationPhotoRow): LocationPhoto {
  return {
    id: row.id,
    locationId: row.location_id,
    caption: row.caption ?? null,
    thumbnailBlob: row.thumbnail_blob ?? null,
    fullResOpfsPath: row.full_res_opfs_path,
    fullResDowngradedAt: row.full_res_downgraded_at ?? null,
    naturalWidth: row.natural_width,
    naturalHeight: row.natural_height,
    position: row.position,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function rowToLocationRegion(row: LocationRegionRow): LocationRegion {
  return {
    id: row.id,
    photoId: row.photo_id,
    name: row.name,
    shape: row.shape,
    geometry: row.geometry,
    color: row.color ?? null,
    position: row.position,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function rowToItemAttachment(row: ItemAttachmentRow): ItemAttachment {
  return {
    id: row.id,
    itemId: row.item_id,
    kind: row.kind,
    value: row.value,
    label: row.label,
    position: row.position,
    originDeviceId: row.origin_device_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function rowToItemAlias(row: ItemAliasRow): ItemAlias {
  return { id: row.id, itemId: row.item_id, alias: row.alias, updatedAt: row.updated_at };
}

export function rowToCapability(row: CapabilityRow): Capability {
  return {
    id: row.id,
    itemId: row.item_id,
    key: row.key,
    valueNum: row.value_num,
    valueText: row.value_text,
    weight: row.weight,
    updatedAt: row.updated_at,
  };
}

export function rowToContact(row: ContactRow): Contact {
  return {
    id: row.id,
    name: row.name,
    note: row.note,
    phoneMobile: row.phone_mobile,
    phoneHome: row.phone_home,
    email: row.email,
    address: row.address,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * Which borrower target a checkout row carries (B4). Exactly one of the three FK columns is
 * non-null (the `checkouts` XOR CHECK guarantees it), so this resolves the row's tagged-union
 * discriminant. A row that somehow has none (should be impossible under the CHECK) falls back
 * to `contact`, the historical default.
 */
export function borrowerTypeOf(
  row: Pick<CheckoutRow, 'contact_id' | 'project_id' | 'location_id'>,
): BorrowerType {
  if (row.project_id !== null) return 'project';
  if (row.location_id !== null) return 'location';
  return 'contact';
}

export function rowToCheckout(row: CheckoutRow): Checkout {
  return {
    id: row.id,
    itemId: row.item_id,
    borrowerType: borrowerTypeOf(row),
    contactId: row.contact_id,
    projectId: row.project_id,
    locationId: row.location_id,
    quantity: row.quantity,
    dueDate: row.due_date,
    checkedOutAt: row.checked_out_at,
    returnedAt: row.returned_at,
    note: row.note,
    returnNote: row.return_note,
    sourceLocationId: row.source_location_id,
    sourceBatchKey: row.source_batch_key,
    updatedAt: row.updated_at,
  };
}

export function rowToBooking(row: AssetBookingRow): AssetBooking {
  return {
    id: row.id,
    itemId: row.item_id,
    contactId: row.contact_id,
    startDate: row.start_date,
    endDate: row.end_date,
    note: row.note,
    cancelledAt: row.cancelled_at,
    convertedCheckoutId: row.converted_checkout_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function rowToMaintenanceSchedule(row: MaintenanceScheduleRow): MaintenanceSchedule {
  return {
    id: row.id,
    itemId: row.item_id,
    name: row.name,
    basis: row.basis,
    intervalDays: row.interval_days,
    intervalUsage: row.interval_usage,
    usageUnit: row.usage_unit,
    usageSinceService: row.usage_since_service,
    accrueCheckoutHours: row.accrue_checkout_hours === 1,
    autoUsageHours: Number(row.auto_usage_hours ?? 0),
    locationId: row.location_id,
    locationName: row.location_name ?? null,
    lastPerformedAt: row.last_performed_at,
    note: row.note,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function rowToProject(row: ProjectRow): Project {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    icon: row.icon,
    status: row.status,
    costingMode: row.costing_mode,
    budget: fromStoredMoney(row.budget),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function rowToBudgetCategory(row: ProjectBudgetCategoryRow): ProjectBudgetCategory {
  return {
    id: row.id,
    projectId: row.project_id,
    name: row.name,
    amount: fromStoredMoney(row.amount),
    position: row.position,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function rowToExpense(row: ProjectExpenseRow): ProjectExpense {
  return {
    id: row.id,
    projectId: row.project_id,
    categoryId: row.category_id,
    description: row.description,
    amount: fromStoredMoney(row.amount),
    incurredAt: row.incurred_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function rowToBomLine(row: ProjectBomLineRow): ProjectBomLine {
  return {
    id: row.id,
    projectId: row.project_id,
    itemId: row.item_id,
    designator: row.designator,
    mpn: row.mpn,
    manufacturer: row.manufacturer,
    description: row.description,
    requiredQty: row.required_qty,
    reservedQty: row.reserved_qty,
    receivedQty: row.received_qty,
    picked: row.picked === 1,
    reservationStatus: row.reservation_status,
    procurementStatus: row.procurement_status,
    unitCostSnapshot: fromStoredMoney(row.unit_cost_snapshot),
    position: row.position,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * Map a `users` row to its DTO. The password triple is deliberately dropped rather than
 * mapped: {@link User} has no field for it, so a hash cannot leak through anything that
 * consumes a mapped user (issue #79, plan §1.1).
 */
export function rowToUser(row: UserRow): User {
  return {
    id: row.id,
    username: row.username,
    displayName: row.display_name,
    email: row.email,
    description: row.description,
    hasPassword: row.password_hash !== null,
    isEnabled: row.is_enabled === 1,
    disabledMessage: row.disabled_message,
    kind: row.kind,
    roleId: row.role_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * Map a `roles` row to its DTO. `permissions` is stored as a JSON array; a row whose column
 * is unparseable or not an array degrades to *no* permissions rather than throwing — a role
 * that fails to load must not be able to grant anything.
 */
export function rowToRole(row: RoleRow): Role {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    permissions: parsePermissions(row.permissions),
    isBuiltin: row.is_builtin === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * Map an `api_tokens` row to its DTO. `token_hash` is deliberately dropped rather than
 * mapped, exactly as the password triple is above: {@link ApiToken} has no field for it, so
 * it cannot leak through anything that consumes a mapped token (issue #79, plan §1.3).
 */
export function rowToApiToken(row: ApiTokenRow): ApiToken {
  return {
    id: row.id,
    userId: row.user_id,
    name: row.name,
    tokenPrefix: row.token_prefix,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function parsePermissions(raw: string): readonly string[] {
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((p): p is string => typeof p === 'string') : [];
  } catch {
    return [];
  }
}
