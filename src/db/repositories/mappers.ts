/**
 * Pure mapping between raw SQLite rows and the camelCase domain objects.
 * SQLite STRICT stores booleans as 0/1 integers and JSON blobs as TEXT; mapping
 * is centralised here so every read returns consistently shaped, typed domain data.
 */
import { currentGrossWeight, percentageRemaining } from './gauge';
import type {
  Category,
  CategoryField,
  CategoryFieldRow,
  CategoryRow,
  GaugeState,
  Item,
  ItemAttachment,
  ItemAttachmentRow,
  ItemHistoryEntry,
  ItemHistoryRow,
  ItemImage,
  ItemImageRow,
  ItemRow,
  Location,
  LocationRow,
  Tag,
  TagRow,
} from './types';

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
    const net = row.current_net_value as number;
    const gross = row.gross_capacity as number;
    gauge = {
      unitOfMeasure: row.unit_of_measure as string,
      grossCapacity: gross,
      tareWeight: tare,
      currentNetValue: net,
      percentageRemaining: percentageRemaining(net, gross),
      currentGrossWeight: currentGrossWeight(net, tare),
      operationalMetadata: parseJson(row.operational_metadata),
    };
  }

  return {
    id: row.id,
    name: row.name,
    description: row.description,
    locationId: row.location_id,
    categoryId: row.category_id,
    trackingMode: row.tracking_mode,
    quantity: row.quantity,
    serialNo: row.serial_no,
    isActive: row.is_active === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    gauge,
    // Only populated by reads that JOIN item_images (§4.2.4); never the full-res path.
    thumbnailBlob: 'thumbnail_blob' in row ? (row.thumbnail_blob ?? null) : undefined,
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

export function rowToCategory(row: CategoryRow): Category {
  return { id: row.id, name: row.name, updatedAt: row.updated_at };
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
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
