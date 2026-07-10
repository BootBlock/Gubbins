/**
 * Pure mapping between raw SQLite rows and the camelCase domain objects.
 * SQLite STRICT stores booleans as 0/1 integers and JSON blobs as TEXT; mapping
 * is centralised here so every read returns consistently shaped, typed domain data.
 */
import { currentGrossWeight, percentageRemaining } from './gauge';
import type {
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
  CategoryRow,
  GaugeState,
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
  SupplierPartRow,
  SupplierPartPriceHistoryEntry,
  SupplierPartPriceHistoryRow,
  Revaluation,
  RevaluationRow,
  ItemRelation,
  ItemRelationRow,
  ItemRelationView,
  TestRecord,
  TestRecordRow,
  Tag,
  TagRow,
  WishlistEntry,
  WishlistRow,
} from './types';
import type { RelationKind } from '@/features/inventory/item-relations';
import { normaliseTestRecordKind, normaliseTestResult } from '@/features/inventory/test-records';
import { normaliseWishlistPriority } from '@/features/purchasing/wishlist';

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
    unitCost: row.unit_cost,
    expiryDate: row.expiry_date,
    batchNumber: row.batch_number,
    lotNumber: row.lot_number,
    condition: row.condition,
    parentId: row.parent_id,
    // "Unlimited supply" modifier (Phase 82); DISCRETE-only infinite source.
    isUnlimited: row.is_unlimited === 1,
    // Per-item reorder policy (Phase 59); null = fall back to the global default.
    reorderPoint: row.reorder_point,
    reorderGaugePercent: row.reorder_gauge_percent,
    reorderQty: row.reorder_qty,
    // Asset lifecycle facet (Phase 66, v24); all null for pre-v24 items (additive).
    acquiredAt: row.acquired_at,
    warrantyExpiresAt: row.warranty_expires_at,
    purchasePrice: row.purchase_price,
    depreciationMonths: row.depreciation_months,
    // Manual current / market value (feature-gap G9, v4); null for items never revalued.
    currentValue: row.current_value,
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
function parsePriceBreaks(value: string | null): PriceBreak[] {
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
    supplierName: row.supplier_name,
    orderCode: row.order_code,
    unitCost: row.unit_cost,
    currency: row.currency,
    packQty: row.pack_qty,
    minOrderQty: row.min_order_qty,
    priceBreaks: parsePriceBreaks(row.price_breaks),
    url: row.url,
    isPreferred: row.is_preferred === 1,
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
    unitCost: row.unit_cost,
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
    value: row.value,
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
    targetPrice: row.target_price,
    priority: normaliseWishlistPriority(row.priority),
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

export function rowToPurchaseOrder(row: PurchaseOrderRow): PurchaseOrder {
  return {
    id: row.id,
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
    unitCost: row.unit_cost,
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

/** Compose a joined activity-feed row (history + owning item name/state). */
export function rowToActivityFeedEntry(row: ActivityFeedRow): ActivityFeedEntry {
  return {
    ...rowToHistoryEntry(row),
    itemName: row.item_name,
    itemIsActive: row.item_is_active === 1,
  };
}

export function rowToCategory(row: CategoryRow): Category {
  return {
    id: row.id,
    name: row.name,
    defaultTrackingMode: row.default_tracking_mode,
    defaultCondition: row.default_condition,
    defaultWarrantyMonths: row.default_warranty_months,
    defaultMaintenanceBasis: row.default_maintenance_basis,
    defaultMaintenanceIntervalDays: row.default_maintenance_interval_days,
    defaultMaintenanceIntervalUsage: row.default_maintenance_interval_usage,
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
    name: row.name,
    fieldType: row.field_type,
    options: parseStringArray(row.options),
    isRequired: row.is_required === 1,
    defaultValue: row.default_value,
    position: row.position,
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

export function rowToCheckout(row: CheckoutRow): Checkout {
  return {
    id: row.id,
    itemId: row.item_id,
    contactId: row.contact_id,
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
    budget: row.budget,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function rowToBudgetCategory(row: ProjectBudgetCategoryRow): ProjectBudgetCategory {
  return {
    id: row.id,
    projectId: row.project_id,
    name: row.name,
    amount: row.amount,
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
    amount: row.amount,
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
    reservationStatus: row.reservation_status,
    procurementStatus: row.procurement_status,
    unitCostSnapshot: row.unit_cost_snapshot,
    position: row.position,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
