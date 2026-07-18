/**
 * Supplier row + DTO types (issue #384).
 *
 * A supplier is a first-class record so its name, URL and default currency live in exactly
 * one place. Both `supplier_parts` and `purchase_orders` reference it by id, which is what
 * makes renaming and merging possible — before this, each carried its own free-text name and
 * the same supplier spelled two ways was two unrelated strings.
 *
 * Names are canonical: the DB holds a case-insensitive UNIQUE index, and
 * {@link ../../../lib/supplier-name} folds spacing and punctuation on top of that.
 */

export interface SupplierRow {
  readonly id: string;
  readonly name: string;
  /** Derived identity key (see `supplierNameKey`); UNIQUE, maintained by the repository. */
  readonly name_key: string;
  readonly url: string | null;
  readonly currency: string | null;
  readonly note: string | null;
  readonly created_at: number;
  readonly updated_at: number;
}

export interface Supplier {
  readonly id: string;
  readonly name: string;
  /** Supplier's home page / storefront; the per-part `url` still points at the part itself. */
  readonly url: string | null;
  /** ISO code used as the default when a part or order under this supplier omits one. */
  readonly currency: string | null;
  readonly note: string | null;
  readonly createdAt: number;
  readonly updatedAt: number;
}

/**
 * A supplier plus the denormalised counts that say what a delete would cost — mirrors
 * `ContactWithCount`. `partCount` is what cascades away with it; `orderCount` is what survives
 * it unlinked (purchase_orders is ON DELETE SET NULL), and both are stated before the confirm.
 */
export interface SupplierWithCounts extends Supplier {
  readonly partCount: number;
  readonly orderCount: number;
}

export interface CreateSupplierInput {
  readonly name: string;
  readonly url?: string | null;
  readonly currency?: string | null;
  readonly note?: string | null;
}

/** Partial update; an omitted key is left unchanged, an explicit `null` clears it. */
export interface UpdateSupplierInput {
  readonly name?: string;
  readonly url?: string | null;
  readonly currency?: string | null;
  readonly note?: string | null;
}

/**
 * How a write names its supplier. Callers that already hold an id pass it; entry points where
 * the user types a name pass that instead and the repository resolves it to an existing
 * supplier (folding case, spacing and punctuation) or creates one. Exactly one is required —
 * this is the single seam through which a supplier name may enter the database.
 */
export type SupplierRef = { readonly supplierId: string } | { readonly supplierName: string };
