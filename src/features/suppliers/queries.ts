/**
 * Tier-1 read hooks for the supplier dictionary (issue #384).
 *
 * Suppliers are a first-class entity referenced by both `supplier_parts` (inventory) and
 * `purchase_orders` (purchasing), so the hooks live in their own feature rather than under
 * either consumer — the same shape `contacts` uses for the borrower dictionary.
 *
 * Reads go through TanStack Query, never straight from a component (spec §2.1).
 */
import { useQuery } from '@tanstack/react-query';
import { getSupplierRepository } from '@/db/repositories';

export const supplierKeys = {
  all: ['suppliers'] as const,
  list: () => [...supplierKeys.all, 'list'] as const,
  detail: (id: string) => [...supplierKeys.all, 'detail', id] as const,
} as const;

/**
 * The canonical supplier list, name-ordered, that the {@link SupplierPicker} offers.
 *
 * Capped at the strict-pagination maximum (§2.1) — a supplier dictionary is a small
 * hand-curated list, so one page is the whole of it in practice. Kept briefly fresh so
 * re-opening a dialog does not re-read a set that changes only when a supplier is added.
 */
export function useSuppliers() {
  return useQuery({
    queryKey: supplierKeys.list(),
    queryFn: () => getSupplierRepository().list({ limit: 100 }),
    staleTime: 60_000,
  });
}

/** A single supplier by id — for surfaces that hold only the stored `supplier_id`. */
export function useSupplier(id: string | undefined) {
  return useQuery({
    queryKey: supplierKeys.detail(id ?? ''),
    queryFn: () => getSupplierRepository().getById(id!),
    enabled: Boolean(id),
  });
}
