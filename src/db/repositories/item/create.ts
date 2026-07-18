/**
 * Pure creation helpers: validate/normalise a {@link CreateItemInput} into concrete
 * column values, and build the INSERT + CREATED-log statement pair for one record.
 *
 * Neither function touches the database — they only shape statements — so the create,
 * serialised-clone and variant paths can all share them without the class.
 */
import { DbError } from '../../errors';
import type { SqlStatement } from '../../rpc/driver';
import { UNASSIGNED_LOCATION_ID } from '../constants';
import { ATTRITION_PERCENT_BOUNDS, isValidAttritionPercent } from '../gauge';
import { setStockStatement } from '../stock';
import type { CreateItemInput } from '../types';
import { historyStatement } from './history';
import {
  normaliseCurrentValue,
  normaliseExpiry,
  normaliseIsoDate,
  normalisePurchasePrice,
  normaliseDepreciationMonths,
  normaliseReorderInt,
  normaliseReorderPercent,
  normaliseText,
  normaliseUnitCost,
  normaliseWeight,
  normaliseDimension,
} from './normalise';

/** Normalised column values produced by {@link resolveCreate}. */
export interface ResolvedCreate {
  readonly name: string;
  readonly description: string | null;
  readonly notes: string | null;
  readonly locationId: string;
  readonly categoryId: string | null;
  readonly mpn: string | null;
  readonly manufacturer: string | null;
  readonly barcode: string | null;
  readonly serialNumber: string | null;
  readonly unitCost: number | null;
  readonly expiryDate: number | null;
  readonly batchNumber: string | null;
  readonly lotNumber: string | null;
  readonly condition: string | null;
  /** 0/1 for the STRICT INTEGER `is_unlimited` column (Phase 82). */
  readonly isUnlimited: number;
  /** 0/1 for the STRICT INTEGER `is_favourite` column (issue #23). */
  readonly isFavourite: number;
  readonly reorderPoint: number | null;
  readonly reorderGaugePercent: number | null;
  readonly reorderQty: number | null;
  readonly acquiredAt: string | null;
  readonly warrantyExpiresAt: string | null;
  readonly purchasePrice: number | null;
  readonly depreciationMonths: number | null;
  readonly weight: number | null;
  readonly width: number | null;
  readonly height: number | null;
  readonly depth: number | null;
  readonly currentValue: number | null;
  readonly trackingMode: string;
  readonly quantity: number;
  readonly unit: string | null;
  readonly grossCapacity: number | null;
  readonly tareWeight: number | null;
  readonly netValue: number | null;
  readonly attritionPercent: number | null;
  readonly operationalMetadata: string | null;
}

/** Validate and normalise creation input into the concrete column values. */
export function resolveCreate(input: CreateItemInput): ResolvedCreate {
  const name = input.name.trim();
  if (name.length === 0) {
    throw new DbError('SQLITE_CONSTRAINT', 'An item must have a name.');
  }

  const trackingMode = input.trackingMode ?? 'DISCRETE';
  const locationId = input.locationId ?? UNASSIGNED_LOCATION_ID;

  // "Unlimited supply" (Phase 82) is a DISCRETE-only modifier — mirror the DB CHECK with a
  // clear application error (the import path relies on this to reject bad rows before insert).
  const isUnlimited = input.isUnlimited === true;
  if (isUnlimited && trackingMode !== 'DISCRETE') {
    throw new DbError(
      'SQLITE_CONSTRAINT',
      `Only DISCRETE items can be marked as unlimited supply (this is ${trackingMode}).`,
    );
  }

  let quantity = input.quantity ?? (trackingMode === 'SERIALISED' ? 1 : 0);
  if (trackingMode === 'SERIALISED') quantity = 1;
  if (quantity < 0) {
    throw new DbError('SQLITE_CONSTRAINT', 'Quantity cannot be negative.');
  }

  let unit: string | null = null;
  let grossCapacity: number | null = null;
  let tareWeight: number | null = null;
  let netValue: number | null = null;
  let attritionPercent: number | null = null;
  let operationalMetadata: string | null = null;

  if (trackingMode === 'CONSUMABLE_GAUGE') {
    const gauge = input.gauge;
    if (!gauge || !gauge.unitOfMeasure || !(gauge.grossCapacity > 0)) {
      throw new DbError(
        'SQLITE_CONSTRAINT',
        'A Consumable-Gauge item requires a unit of measure and a positive gross capacity.',
      );
    }
    unit = gauge.unitOfMeasure;
    grossCapacity = gauge.grossCapacity;
    tareWeight = gauge.tareWeight ?? 0;
    netValue = gauge.currentNetValue ?? gauge.grossCapacity;
    if (tareWeight < 0 || netValue < 0) {
      throw new DbError('SQLITE_CONSTRAINT', 'Gauge weights cannot be negative.');
    }
    // Attrition (issue #89) is optional — absent and null both mean "no attrition" — but a
    // supplied rate must be in range, mirroring the DB CHECK with a legible error for the
    // import path, which rejects bad rows before they reach SQLite.
    if (gauge.attritionPercent !== undefined && gauge.attritionPercent !== null) {
      if (!isValidAttritionPercent(gauge.attritionPercent)) {
        throw new DbError(
          'SQLITE_CONSTRAINT',
          `Attrition must be between ${ATTRITION_PERCENT_BOUNDS.min} and ${ATTRITION_PERCENT_BOUNDS.max} percent.`,
        );
      }
      attritionPercent = gauge.attritionPercent;
    }
    operationalMetadata = gauge.operationalMetadata ? JSON.stringify(gauge.operationalMetadata) : null;
  }

  return {
    name,
    description: input.description ?? null,
    notes: input.notes ?? null,
    locationId,
    categoryId: input.categoryId ?? null,
    mpn: normaliseText(input.mpn),
    manufacturer: normaliseText(input.manufacturer),
    barcode: normaliseText(input.barcode),
    serialNumber: normaliseText(input.serialNumber),
    unitCost: normaliseUnitCost(input.unitCost),
    expiryDate: normaliseExpiry(input.expiryDate),
    batchNumber: normaliseText(input.batchNumber),
    lotNumber: normaliseText(input.lotNumber),
    condition: input.condition ?? null,
    isUnlimited: isUnlimited ? 1 : 0,
    isFavourite: input.isFavourite === true ? 1 : 0,
    reorderPoint: normaliseReorderInt(input.reorderPoint),
    reorderGaugePercent: normaliseReorderPercent(input.reorderGaugePercent),
    reorderQty: normaliseReorderInt(input.reorderQty),
    acquiredAt: normaliseIsoDate(input.acquiredAt),
    warrantyExpiresAt: normaliseIsoDate(input.warrantyExpiresAt),
    purchasePrice: normalisePurchasePrice(input.purchasePrice),
    depreciationMonths: normaliseDepreciationMonths(input.depreciationMonths),
    weight: normaliseWeight(input.weight),
    width: normaliseDimension(input.width, 'Width'),
    height: normaliseDimension(input.height, 'Height'),
    depth: normaliseDimension(input.depth, 'Depth'),
    currentValue: normaliseCurrentValue(input.currentValue),
    trackingMode,
    quantity,
    unit,
    grossCapacity,
    tareWeight,
    netValue,
    attritionPercent,
    operationalMetadata,
  };
}

/** Build the INSERT + CREATED-log statement pair for one item record. */
export function buildInsert(
  id: string,
  r: ResolvedCreate,
  serialNo: number | null,
  parentId: string | null = null,
): SqlStatement[] {
  return [
    {
      sql: `INSERT INTO items
              (id, name, description, notes, location_id, category_id, tracking_mode, quantity, serial_no,
               unit_of_measure, gross_capacity, tare_weight, current_net_value, attrition_percent, operational_metadata,
               mpn, manufacturer, barcode, serial_number, unit_cost, expiry_date, batch_number, lot_number, condition, is_unlimited, is_favourite,
               reorder_point, reorder_gauge_percent, reorder_qty, parent_id,
               acquired_at, warranty_expires_at, purchase_price, depreciation_months, weight, width, height, depth, current_value)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);`,
      params: [
        id,
        r.name,
        r.description,
        r.notes,
        r.locationId,
        r.categoryId,
        r.trackingMode,
        r.quantity,
        serialNo,
        r.unit,
        r.grossCapacity,
        r.tareWeight,
        r.netValue,
        r.attritionPercent,
        r.operationalMetadata,
        r.mpn,
        r.manufacturer,
        r.barcode,
        r.serialNumber,
        r.unitCost,
        r.expiryDate,
        r.batchNumber,
        r.lotNumber,
        r.condition,
        r.isUnlimited,
        r.isFavourite,
        r.reorderPoint,
        r.reorderGaugePercent,
        r.reorderQty,
        parentId,
        r.acquiredAt,
        r.warrantyExpiresAt,
        r.purchasePrice,
        r.depreciationMonths,
        r.weight,
        r.width,
        r.height,
        r.depth,
        r.currentValue,
      ],
    },
    // Seed the item's primary placement in the per-location ledger (Phase 25). The
    // recompute trigger then keeps `items.quantity` equal to this (and any future
    // placements). Runs after the items INSERT so the FK + trigger resolve.
    setStockStatement(id, r.locationId, r.quantity),
    historyStatement(id, parentId === null ? 'CREATED' : 'VARIANT_CREATED', {
      note:
        parentId !== null
          ? `Created variant "${r.name}".`
          : serialNo === null
            ? `Created "${r.name}".`
            : `Created "${r.name}" #${serialNo}.`,
      metadata: { trackingMode: r.trackingMode, locationId: r.locationId },
    }),
  ];
}
