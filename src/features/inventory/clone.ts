/**
 * Item-clone pure seam (Phase 76, third feature-gap audit candidate #3).
 *
 * "Duplicate item" seeds a brand-new item from an existing one (item-as-template). The policy
 * lives here, out of the glue (house pattern): {@link planItemClone} maps a source {@link Item}
 * to a {@link CreateItemInput}, **copying the descriptive/template fields** and **stripping the
 * per-instance identity** (serial number, batch/lot, expiry, acquisition dates, purchase price)
 * while **resetting stock to zero**. Sibling helpers map the source's supplier parts and stored
 * custom-field values for the clone mutation to re-create. All pure and unit-tested; the mutation
 * just orchestrates the existing repository writes. **No schema change.**
 */
import type { CreateItemInput, Item, ResolvedItemField, SupplierPart } from '@/db/repositories';
import type { CreateSupplierPartInput } from '@/db/repositories';

/** Default suffix appended to the cloned item's name so the copy is distinguishable. */
export const CLONE_NAME_SUFFIX = ' (copy)';

/**
 * Build a {@link CreateItemInput} seed from a source item.
 *
 * **Copied** (template identity): name (+ suffix), description, location, category, MPN,
 * manufacturer, unit cost, condition, reorder thresholds, depreciation months, tracking mode and
 * — for gauges — the gauge shape (unit / capacity / tare).
 *
 * **Stripped** (per-instance): serial number (auto-assigned afresh), batch/lot number, expiry
 * date, acquired-at, warranty-expiry, purchase price and free-text notes — these describe *this
 * physical unit/lot* (or the owner's remarks about it), not the template.
 *
 * **Reset**: quantity to 0 (DISCRETE) and gauge net value to 0 — a clone starts with no stock; you
 * add it afterwards. SERIALISED clones request a single fresh instance (`count: 1`).
 *
 * Operational metadata is *not* placed here (a non-gauge `CreateItemInput` cannot carry it); the
 * clone mutation copies it via a follow-up `update`.
 */
export function planItemClone(source: Item, options: { readonly nameSuffix?: string } = {}): CreateItemInput {
  const suffix = options.nameSuffix ?? CLONE_NAME_SUFFIX;
  const base: CreateItemInput = {
    name: `${source.name}${suffix}`,
    description: source.description,
    locationId: source.locationId,
    categoryId: source.categoryId,
    mpn: source.mpn,
    manufacturer: source.manufacturer,
    unitCost: source.unitCost,
    condition: source.condition,
    reorderPoint: source.reorderPoint,
    reorderGaugePercent: source.reorderGaugePercent,
    reorderQty: source.reorderQty,
    // Useful-life depreciation is a template setting; the acquisition *date/price* are not copied.
    depreciationMonths: source.depreciationMonths,
    trackingMode: source.trackingMode,
  };

  if (source.trackingMode === 'CONSUMABLE_GAUGE' && source.gauge) {
    return {
      ...base,
      gauge: {
        unitOfMeasure: source.gauge.unitOfMeasure,
        grossCapacity: source.gauge.grossCapacity,
        tareWeight: source.gauge.tareWeight,
        currentNetValue: 0, // reset: the clone starts empty
      },
    };
  }

  if (source.trackingMode === 'SERIALISED') {
    return { ...base, count: 1 };
  }

  // DISCRETE — reset the on-hand count.
  return { ...base, quantity: 0 };
}

/** Map a source supplier part to a creation input for the clone (preserving the preferred flag). */
export function clonedSupplierPartInput(part: SupplierPart): CreateSupplierPartInput {
  return {
    supplierName: part.supplierName,
    orderCode: part.orderCode,
    unitCost: part.unitCost,
    currency: part.currency,
    packQty: part.packQty,
    minOrderQty: part.minOrderQty,
    priceBreaks: part.priceBreaks.length > 0 ? part.priceBreaks : null,
    url: part.url,
    isPreferred: part.isPreferred,
  };
}

/**
 * Reduce the source item's resolved category fields to the `{ fieldId: value }` map the clone
 * should persist — only **stored** values (a field left at its default is not copied, so the
 * clone inherits the same lenient defaulting). Returns `{}` when nothing is stored.
 */
export function clonedFieldValues(fields: readonly ResolvedItemField[]): Record<string, string> {
  const values: Record<string, string> = {};
  for (const field of fields) {
    if (field.hasStoredValue && field.value !== null) {
      values[field.id] = field.value;
    }
  }
  return values;
}
