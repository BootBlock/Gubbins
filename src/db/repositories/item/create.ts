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
import { setStockStatement } from '../stock';
import type { CreateItemInput } from '../types';
import { historyStatement } from './history';
import {
  normaliseExpiry,
  normaliseIsoDate,
  normalisePurchasePrice,
  normaliseDepreciationMonths,
  normaliseReorderInt,
  normaliseReorderPercent,
  normaliseText,
  normaliseUnitCost,
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
  readonly unitCost: number | null;
  readonly expiryDate: number | null;
  readonly batchNumber: string | null;
  readonly lotNumber: string | null;
  readonly condition: string | null;
  readonly reorderPoint: number | null;
  readonly reorderGaugePercent: number | null;
  readonly reorderQty: number | null;
  readonly acquiredAt: string | null;
  readonly warrantyExpiresAt: string | null;
  readonly purchasePrice: number | null;
  readonly depreciationMonths: number | null;
  readonly trackingMode: string;
  readonly quantity: number;
  readonly unit: string | null;
  readonly grossCapacity: number | null;
  readonly tareWeight: number | null;
  readonly netValue: number | null;
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

  let quantity = input.quantity ?? (trackingMode === 'SERIALISED' ? 1 : 0);
  if (trackingMode === 'SERIALISED') quantity = 1;
  if (quantity < 0) {
    throw new DbError('SQLITE_CONSTRAINT', 'Quantity cannot be negative.');
  }

  let unit: string | null = null;
  let grossCapacity: number | null = null;
  let tareWeight: number | null = null;
  let netValue: number | null = null;
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
    unitCost: normaliseUnitCost(input.unitCost),
    expiryDate: normaliseExpiry(input.expiryDate),
    batchNumber: normaliseText(input.batchNumber),
    lotNumber: normaliseText(input.lotNumber),
    condition: input.condition ?? null,
    reorderPoint: normaliseReorderInt(input.reorderPoint),
    reorderGaugePercent: normaliseReorderPercent(input.reorderGaugePercent),
    reorderQty: normaliseReorderInt(input.reorderQty),
    acquiredAt: normaliseIsoDate(input.acquiredAt),
    warrantyExpiresAt: normaliseIsoDate(input.warrantyExpiresAt),
    purchasePrice: normalisePurchasePrice(input.purchasePrice),
    depreciationMonths: normaliseDepreciationMonths(input.depreciationMonths),
    trackingMode,
    quantity,
    unit,
    grossCapacity,
    tareWeight,
    netValue,
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
               unit_of_measure, gross_capacity, tare_weight, current_net_value, operational_metadata,
               mpn, manufacturer, unit_cost, expiry_date, batch_number, lot_number, condition,
               reorder_point, reorder_gauge_percent, reorder_qty, parent_id,
               acquired_at, warranty_expires_at, purchase_price, depreciation_months)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);`,
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
        r.operationalMetadata,
        r.mpn,
        r.manufacturer,
        r.unitCost,
        r.expiryDate,
        r.batchNumber,
        r.lotNumber,
        r.condition,
        r.reorderPoint,
        r.reorderGaugePercent,
        r.reorderQty,
        parentId,
        r.acquiredAt,
        r.warrantyExpiresAt,
        r.purchasePrice,
        r.depreciationMonths,
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
