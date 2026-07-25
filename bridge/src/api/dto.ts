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
  Checkout,
  Item,
  LocationFieldValue,
  LocationWithCount,
  ResolvedItemField,
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
  /**
   * Grand total of rows matching the query across all pages — present only when the caller
   * asked for it with the OData `$count=true` option (it costs an extra COUNT query).
   */
  readonly total?: number;
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
  /**
   * On-hand grand total across every location — **`null` for an unlimited-supply item**
   * (`isUnlimited`), since an effectively infinite source has no finite count and JSON has
   * no `Infinity`.
   */
  readonly quantity: number | null;
  readonly locationId: string;
  readonly locationName: string | null;
  readonly categoryId: string | null;
  readonly mpn: string | null;
  readonly manufacturer: string | null;
  readonly trackingMode: Item['trackingMode'];
  readonly isActive: boolean;
  /** `true` for an effectively infinite source (tap water, mains air); its `quantity` is `null`. */
  readonly isUnlimited: boolean;
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

/**
 * The half of a custom-field value that is the same whichever record holds it: the
 * dictionary definition's name and type, plus the effective value.
 *
 * Custom fields are the app's **field dictionary** — user-defined metadata (a supplier
 * reference, a datasheet URL, the entity id of the lamp above a shelf) recorded against an
 * item or a location. They are keyed by *name*, globally, so the same "Datasheet" field
 * means the same thing everywhere; the value is always the app's stored text.
 */
export interface FieldValueDto {
  /** The field's name in the dictionary, e.g. `Datasheet`. Unique app-wide (case-insensitive). */
  readonly name: string;
  /** The definition's declared type (`TEXT`, `NUMBER`, `SELECT`, …). */
  readonly fieldType: CategoryField['fieldType'];
  /** The effective value as the app stores it — always text, never coerced. */
  readonly value: string;
}

/** The location an inherited item field value came from. */
export interface FieldInheritedFromDto {
  readonly locationId: string;
  readonly locationName: string;
}

/**
 * One resolved custom-field value of an **item**, with location inheritance already applied
 * exactly as the app applies it. `source` tells an inherited value apart from a directly-set
 * one, and `inheritedFrom` names the ancestor location that supplied it.
 */
export interface ItemFieldValueDto extends FieldValueDto {
  /** Where the value came from: set on the item, inherited from a location, or the field default. */
  readonly source: ResolvedItemField['source'];
  /** The ancestor location that supplied the value when `source` is `inherited`; null otherwise. */
  readonly inheritedFrom: FieldInheritedFromDto | null;
}

/**
 * One custom-field value held by a **location**. `isInheritable` is the location's opt-in
 * choice to offer this value to the items stored beneath it; a non-inheritable value is the
 * location's own metadata.
 */
export interface LocationFieldValueDto extends FieldValueDto {
  readonly isInheritable: boolean;
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
  /** Intrinsic serial number — the maker's per-unit identifier (issue #90); null if none. */
  readonly serialNumber: string | null;
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
  /**
   * The item's resolved custom-field values — **present only when the caller asks for them**
   * (`include=fields`), so the default payload stays exactly as it was.
   */
  readonly fieldValues?: readonly ItemFieldValueDto[];
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
  /**
   * The custom-field values this location holds — **present only when the caller asks for
   * them** (`include=fields`), so the default payload stays exactly as it was.
   */
  readonly fieldValues?: readonly LocationFieldValueDto[];
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
  /** Optional author's note about the field; null when none. */
  readonly description: string | null;
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

/**
 * One loan (checkout), as the opt-in loan write endpoints return it (issue #142).
 *
 * The **id** is the point of the shape: a caller that has just lent something out needs it to
 * check the same loan back in later, and it is the id the iCalendar feed embeds in that loan's
 * `UID` (`loan-<id>@gubbins.invalid`) — so a calendar-driven automation can close the very loan
 * it was reminded about.
 *
 * `borrowerType` names which of the three targets the loan is to (§4 "Borrowing" B4), and
 * `borrowerId` is that target's id — flattened from the app's tagged union so a consumer can
 * read the borrower without knowing which of three nullable columns to look in.
 */
export interface CheckoutDto {
  readonly id: string;
  readonly itemId: string;
  /** Which kind of target holds the loan: a contact, a project, or a location. */
  readonly borrowerType: Checkout['borrowerType'];
  /** The borrower's id, in whichever table `borrowerType` names. */
  readonly borrowerId: string;
  /** Units lent on this loan (a serialised item always lends as 1). */
  readonly quantity: number;
  /** Due date (UNIX-ms) for overdue tracking, or null for an open-ended loan. */
  readonly dueDate: number | null;
  readonly checkedOutAt: number;
  /** Null while the loan is still out; the return instant once checked in. */
  readonly returnedAt: number | null;
  /** Derived from `returnedAt`, exactly as the app derives it — no stored enum. */
  readonly status: 'OPEN' | 'RETURNED';
  /** The note captured when the units went out. */
  readonly note: string | null;
  /** The note captured on return; null while the loan is open. */
  readonly returnNote: string | null;
  /** The placement the units were drawn from (stock is restored there on return). */
  readonly sourceLocationId: string | null;
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
    // An unlimited-supply item has no finite on-hand count (JSON has no Infinity) — null it.
    quantity: item.isUnlimited ? null : item.quantity,
    locationId: item.locationId,
    locationName,
    categoryId: item.categoryId,
    mpn: item.mpn,
    manufacturer: item.manufacturer,
    trackingMode: item.trackingMode,
    isActive: item.isActive,
    isUnlimited: item.isUnlimited,
  };
}

/**
 * Project a {@link Checkout} into the public loan DTO, flattening the borrower tagged union
 * (exactly one of the three FK columns is non-null, per the `checkouts` XOR CHECK) and deriving
 * the OPEN/RETURNED status from `returnedAt` the same way the app does.
 */
export function toCheckout(checkout: Checkout): CheckoutDto {
  return {
    id: checkout.id,
    itemId: checkout.itemId,
    borrowerType: checkout.borrowerType,
    // The XOR CHECK guarantees one of the three is set; the fallback keeps the DTO total
    // rather than asserting non-null over data the bridge did not write itself.
    borrowerId: checkout.contactId ?? checkout.projectId ?? checkout.locationId ?? '',
    quantity: checkout.quantity,
    dueDate: checkout.dueDate,
    checkedOutAt: checkout.checkedOutAt,
    returnedAt: checkout.returnedAt,
    status: checkout.returnedAt === null ? 'OPEN' : 'RETURNED',
    note: checkout.note,
    returnNote: checkout.returnNote,
    sourceLocationId: checkout.sourceLocationId,
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

/**
 * Project an item's resolved custom fields into the public DTO.
 *
 * Fields with **no effective value** are dropped: a category field an item has never filled
 * in resolves to `null`, and emitting it would pad every payload with empty entries that say
 * nothing. What remains is exactly the metadata the item actually carries.
 */
export function toItemFieldValues(fields: readonly ResolvedItemField[]): ItemFieldValueDto[] {
  const out: ItemFieldValueDto[] = [];
  for (const field of fields) {
    if (field.value === null) continue;
    out.push({
      name: field.name,
      fieldType: field.fieldType,
      value: field.value,
      source: field.source,
      // Only report the origin location for a value that was actually inherited — the
      // repository also reports an *available* offer for a field resolved some other way,
      // and naming it there would imply the value came from it.
      inheritedFrom:
        field.source === 'inherited' && field.inheritable !== null
          ? { locationId: field.inheritable.locationId, locationName: field.inheritable.locationName }
          : null,
    });
  }
  return out;
}

/** Project a location's held custom-field values into the public DTO (empty values dropped). */
export function toLocationFieldValues(values: readonly LocationFieldValue[]): LocationFieldValueDto[] {
  const out: LocationFieldValueDto[] = [];
  for (const value of values) {
    if (value.value === null) continue;
    out.push({
      name: value.name,
      fieldType: value.fieldType,
      value: value.value,
      isInheritable: value.isInheritable,
    });
  }
  return out;
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
    description: field.description,
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
