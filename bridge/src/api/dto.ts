/**
 * Stable, documented DTOs for the versioned read-only API (`/api/v1`).
 *
 * These shapes are a **public contract** — third-party consumers and the OpenAPI spec
 * (`openapi.ts`) depend on them, so treat them as additive-only. Every field is derived
 * from the app's own repositories (no bespoke SQL); nothing here exposes a mutation.
 *
 * Conventions:
 *   - **List** endpoints return a {@link ListEnvelope}: `{ data: [...], pagination }`.
 *   - **Single-resource** endpoints return the resource object directly.
 *   - All ids are the app's stable record ids; timestamps are UNIX-ms integers (as the
 *     app stores them), matching the snapshot.
 */
import type {
  Capability,
  CapabilityKeySummary,
  Category,
  CategoryField,
  CategoryWithFieldCount,
  Item,
  LocationWithCount,
} from '@/db/repositories/types';

/** Offset/limit pagination metadata accompanying every list response. */
export interface PaginationMeta {
  /** The effective page size after clamping to the API's bounds. */
  readonly limit: number;
  /** The zero-based offset of the first row in this page. */
  readonly offset: number;
  /** Number of rows actually returned in `data` (≤ `limit`). */
  readonly count: number;
  /** True when a further page may exist (a full page came back). */
  readonly hasMore: boolean;
}

/** The envelope every list endpoint returns. */
export interface ListEnvelope<T> {
  readonly data: readonly T[];
  readonly pagination: PaginationMeta;
}

/** A compact item view for list/search results. */
export interface ItemSummaryDto {
  readonly id: string;
  readonly name: string;
  /** On-hand grand total across every location. */
  readonly quantity: number;
  readonly locationId: string;
  readonly locationName: string | null;
  readonly categoryId: string | null;
  readonly mpn: string | null;
  readonly manufacturer: string | null;
  readonly trackingMode: Item['trackingMode'];
  readonly isActive: boolean;
}

/** One weighted parametric capability of an item (read-only projection). */
export interface CapabilityDto {
  readonly key: string;
  /** The numeric magnitude when the value is numeric; null for a text value. */
  readonly valueNum: number | null;
  /** The text value when categorical; null for a numeric value. */
  readonly valueText: string | null;
  readonly weight: number;
}

/** One location's share of an item's stock, for the placement breakdown. */
export interface PlacementDto {
  readonly locationId: string;
  readonly locationName: string;
  readonly quantity: number;
}

/** The full item view returned by item lookup-by-id: summary + detail + relations. */
export interface ItemDetailDto extends ItemSummaryDto {
  readonly description: string | null;
  readonly categoryName: string | null;
  readonly unitCost: number | null;
  readonly condition: Item['condition'];
  readonly serialNo: number | null;
  readonly parentId: string | null;
  readonly expiryDate: number | null;
  readonly batchNumber: string | null;
  readonly lotNumber: string | null;
  readonly createdAt: number;
  readonly updatedAt: number;
  /** Per-location stock breakdown (busiest location first). */
  readonly placements: readonly PlacementDto[];
  /** The item's parametric capabilities, ordered by key. */
  readonly capabilities: readonly CapabilityDto[];
}

/** A location with its live (active) item count. */
export interface LocationDto {
  readonly id: string;
  readonly name: string;
  readonly parentId: string | null;
  readonly isSystem: boolean;
  readonly description: string | null;
  readonly color: string | null;
  readonly itemCount: number;
}

/** A custom-field definition belonging to a category. */
export interface CategoryFieldDto {
  readonly id: string;
  readonly name: string;
  readonly fieldType: CategoryField['fieldType'];
  /** Choice list for `SELECT` fields; null otherwise. */
  readonly options: readonly string[] | null;
  readonly isRequired: boolean;
  readonly defaultValue: string | null;
  readonly position: number;
}

/** A compact category view for the list endpoint. */
export interface CategorySummaryDto {
  readonly id: string;
  readonly name: string;
  readonly fieldCount: number;
}

/** A category plus its custom-field schema, for lookup-by-id. */
export interface CategoryDetailDto {
  readonly id: string;
  readonly name: string;
  readonly fields: readonly CategoryFieldDto[];
}

/** One distinct capability key across inventory — the queryable `cap:` vocabulary. */
export interface CapabilityKeyDto {
  readonly key: string;
  readonly itemCount: number;
  readonly hasNumericValues: boolean;
  readonly hasTextValues: boolean;
}

// --- pure mappers (app row/domain types → public DTOs) -----------------------------

/** Project an {@link Item} into the compact summary DTO. `locationName` is resolved by the caller. */
export function toItemSummary(item: Item, locationName: string | null): ItemSummaryDto {
  return {
    id: item.id,
    name: item.name,
    quantity: item.quantity,
    locationId: item.locationId,
    locationName,
    categoryId: item.categoryId,
    mpn: item.mpn,
    manufacturer: item.manufacturer,
    trackingMode: item.trackingMode,
    isActive: item.isActive,
  };
}

export function toCapability(capability: Capability): CapabilityDto {
  return {
    key: capability.key,
    valueNum: capability.valueNum,
    valueText: capability.valueText,
    weight: capability.weight,
  };
}

export function toLocation(location: LocationWithCount): LocationDto {
  return {
    id: location.id,
    name: location.name,
    parentId: location.parentId,
    isSystem: location.isSystem,
    description: location.description,
    color: location.color,
    itemCount: location.itemCount,
  };
}

export function toCategorySummary(category: CategoryWithFieldCount): CategorySummaryDto {
  return { id: category.id, name: category.name, fieldCount: category.fieldCount };
}

export function toCategoryField(field: CategoryField): CategoryFieldDto {
  return {
    id: field.id,
    name: field.name,
    fieldType: field.fieldType,
    options: field.options,
    isRequired: field.isRequired,
    defaultValue: field.defaultValue,
    position: field.position,
  };
}

export function toCategoryDetail(category: Category, fields: readonly CategoryField[]): CategoryDetailDto {
  return { id: category.id, name: category.name, fields: fields.map(toCategoryField) };
}

export function toCapabilityKey(summary: CapabilityKeySummary): CapabilityKeyDto {
  return {
    key: summary.key,
    itemCount: summary.itemCount,
    hasNumericValues: summary.hasNumericValues,
    hasTextValues: summary.hasTextValues,
  };
}
