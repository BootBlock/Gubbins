/**
 * Pure mapping between raw SQLite rows and the camelCase domain objects.
 * SQLite STRICT stores booleans as 0/1 integers and JSON blobs as TEXT; mapping
 * is centralised here so every read returns consistently shaped, typed domain data.
 */
import { currentGrossWeight, percentageRemaining } from './gauge';
import type {
  Category,
  CategoryRow,
  GaugeState,
  Item,
  ItemHistoryEntry,
  ItemHistoryRow,
  ItemRow,
  Location,
  LocationRow,
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
    isActive: row.is_active === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    gauge,
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
