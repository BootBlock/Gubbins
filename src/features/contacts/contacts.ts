/**
 * Tier-1 hooks for the contacts & checkout domain (spec §2.1, §4 Borrowing).
 *
 * Reads go through TanStack Query. Checkout/check-in writes touch the item table
 * (on-hand quantity) and the Activity Ledger as well as the checkout records, so
 * they invalidate `inventoryKeys.items()` alongside the contact/checkout keys.
 * These are deliberately invalidation-based rather than optimistically patched: a
 * single confirmation tap is low-frequency (the *rapid* path is the scanner queue,
 * which batches and commits via these same mutations). Lists are bounded per
 * contact/item and capped at 100 per the strict-pagination mandate (§2.1).
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  getCheckoutRepository,
  getContactRepository,
  type CheckoutItemInput,
  type CreateContactInput,
  type UpdateContactInput,
} from '@/db/repositories';
import { inventoryKeys } from '@/features/inventory/queries';

export const contactKeys = {
  all: ['contacts'] as const,
  list: () => [...contactKeys.all, 'list'] as const,
  detail: (id: string) => [...contactKeys.all, 'detail', id] as const,
  checkoutsForContact: (id: string) => [...contactKeys.detail(id), 'checkouts'] as const,
} as const;

export const checkoutKeys = {
  all: ['checkouts'] as const,
  open: () => [...checkoutKeys.all, 'open'] as const,
  forItem: (itemId: string) => [...checkoutKeys.all, 'item', itemId] as const,
} as const;

// --- reads ---------------------------------------------------------------------

export function useContacts() {
  return useQuery({
    queryKey: contactKeys.list(),
    queryFn: () => getContactRepository().list({ limit: 100 }),
  });
}

export function useOpenCheckouts() {
  return useQuery({
    queryKey: checkoutKeys.open(),
    queryFn: () => getCheckoutRepository().listOpen({ limit: 100 }),
  });
}

export function useItemCheckouts(itemId: string | undefined) {
  return useQuery({
    queryKey: checkoutKeys.forItem(itemId ?? ''),
    queryFn: () => getCheckoutRepository().listForItem(itemId!, { limit: 100 }),
    enabled: Boolean(itemId),
  });
}

export function useContactCheckouts(contactId: string | undefined) {
  return useQuery({
    queryKey: contactKeys.checkoutsForContact(contactId ?? ''),
    queryFn: () => getCheckoutRepository().listForContact(contactId!, { limit: 100 }),
    enabled: Boolean(contactId),
  });
}

// --- contact writes ------------------------------------------------------------

export function useCreateContact() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateContactInput) => getContactRepository().create(input),
    onSettled: () => void client.invalidateQueries({ queryKey: contactKeys.list() }),
  });
}

export function useUpdateContact() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ id, input }: { id: string; input: UpdateContactInput }) =>
      getContactRepository().update(id, input),
    onSettled: () => void client.invalidateQueries({ queryKey: contactKeys.all }),
  });
}

export function useDeleteContact() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => getContactRepository().delete(id),
    onSettled: () => {
      void client.invalidateQueries({ queryKey: contactKeys.all });
      void client.invalidateQueries({ queryKey: checkoutKeys.all });
      void client.invalidateQueries({ queryKey: inventoryKeys.items() });
    },
  });
}

// --- checkout writes -----------------------------------------------------------

/** Invalidate every view a borrow event reshapes (checkouts, contacts, stock). */
function invalidateBorrowing(client: ReturnType<typeof useQueryClient>): void {
  void client.invalidateQueries({ queryKey: checkoutKeys.all });
  void client.invalidateQueries({ queryKey: contactKeys.all });
  void client.invalidateQueries({ queryKey: inventoryKeys.items() });
  // A loan's duration feeds checkout-hours maintenance telemetry (§4.3, Phase 22), so a
  // checkout/return shifts the derived usage on any accrue-mode schedule and the due set.
  void client.invalidateQueries({ queryKey: inventoryKeys.maintenance() });
}

export function useCheckoutItem() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: CheckoutItemInput) => getCheckoutRepository().checkout(input),
    onSettled: () => invalidateBorrowing(client),
  });
}

export function useCheckInItem() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ checkoutId, note }: { checkoutId: string; note?: string }) =>
      getCheckoutRepository().checkIn(checkoutId, note),
    onSettled: () => invalidateBorrowing(client),
  });
}
