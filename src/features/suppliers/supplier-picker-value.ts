/**
 * {@link SupplierPicker}'s value shape and its conversion to a {@link SupplierRef} — a pure
 * seam, kept out of the component file so it is unit-testable in isolation (and so the
 * component module exports only components, for fast-refresh). Mirrors how
 * `autocomplete-filter.ts` sits beside `autocomplete.tsx`.
 */
import type { SupplierRef } from '@/db/repositories';
import { normaliseSupplierName } from '@/lib/supplier-name';

/**
 * What the picker holds: the text in the field, plus the canonical supplier it currently
 * resolves to (`null` while the typed name is not one you already have).
 *
 * The name is kept alongside the id deliberately — a half-typed name is a legitimate state of
 * the control, and forcing the caller to hold only an id would mean it could not represent one.
 */
export interface SupplierPickerValue {
  /** The canonical supplier this resolves to, or `null` for a name that is not (yet) one. */
  readonly supplierId: string | null;
  /** Exactly what is in the field — the user's own spelling, untrimmed while typing. */
  readonly name: string;
}

/** A blank picker value, for seeding an "add" form. */
export const EMPTY_SUPPLIER_VALUE: SupplierPickerValue = { supplierId: null, name: '' };

/**
 * The {@link SupplierRef} a write should carry for this value: the resolved id when the name is
 * one you already have, otherwise the typed name for the repository to resolve-or-create.
 * `null` when the field is blank, which the caller should reject before submitting.
 *
 * Passing a *name* is always safe — `SupplierRepository.resolveOrCreate` folds case, spacing
 * and punctuation onto the existing supplier — so a value whose id was never resolved locally
 * still cannot mint a duplicate. The id is preferred purely because it is exact.
 */
export function supplierRefFrom(value: SupplierPickerValue): SupplierRef | null {
  if (value.supplierId !== null) return { supplierId: value.supplierId };
  const name = normaliseSupplierName(value.name);
  return name.length === 0 ? null : { supplierName: name };
}
