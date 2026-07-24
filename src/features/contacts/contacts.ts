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
  type CheckInOptions,
  type CheckoutItemInput,
  type CreateContactInput,
  type UpdateContactInput,
} from '@/db/repositories';
import { inventoryKeys } from '@/features/inventory/queries';
import { invalidateItems } from '@/features/inventory/invalidate';
import { useReportWriteFailure } from '@/features/errors';

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
  forProject: (projectId: string) => [...checkoutKeys.all, 'project', projectId] as const,
  forLocation: (locationId: string) => [...checkoutKeys.all, 'location', locationId] as const,
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

/** Loans checked out **to** a project (B4) — the open + returned history for a project. */
export function useProjectCheckouts(projectId: string | undefined) {
  return useQuery({
    queryKey: checkoutKeys.forProject(projectId ?? ''),
    queryFn: () => getCheckoutRepository().listForProject(projectId!, { limit: 100 }),
    enabled: Boolean(projectId),
  });
}

/** Loans checked out **to** a location (B4) — the open + returned history for a location. */
export function useLocationCheckouts(locationId: string | undefined) {
  return useQuery({
    queryKey: checkoutKeys.forLocation(locationId ?? ''),
    queryFn: () => getCheckoutRepository().listForLocation(locationId!, { limit: 100 }),
    enabled: Boolean(locationId),
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
  const reportFailure = useReportWriteFailure('contacts.writeError.heading.create', 'common.writeFailed');
  return useMutation({
    mutationFn: (input: CreateContactInput) => getContactRepository().create(input),
    // The add-contact form fires fire-and-forget and clears its inputs on success, so a rejected
    // create would otherwise vanish silently with the typed values (#389).
    onError: reportFailure,
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
  const reportFailure = useReportWriteFailure('contacts.writeError.heading.delete', 'common.writeFailed');
  return useMutation({
    // The delete itself returns every active loan first (restoring stock/history as a normal
    // check-in would) so deleting a contact never silently strands stock still marked "out" —
    // in the *same* transaction, so the returns can't survive a failed delete (issue #301).
    mutationFn: (id: string) => getContactRepository().delete(id),
    // Deletion is fired straight from the row with no error surface at the call site (#389).
    onError: reportFailure,
    onSettled: () => {
      void client.invalidateQueries({ queryKey: contactKeys.all });
      void client.invalidateQueries({ queryKey: checkoutKeys.all });
      invalidateItems(client);
    },
  });
}

// --- checkout writes -----------------------------------------------------------

/** Invalidate every view a borrow event reshapes (checkouts, contacts, stock). */
function invalidateBorrowing(client: ReturnType<typeof useQueryClient>): void {
  void client.invalidateQueries({ queryKey: checkoutKeys.all });
  void client.invalidateQueries({ queryKey: contactKeys.all });
  invalidateItems(client);
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
    mutationFn: ({ checkoutId, ...options }: { checkoutId: string } & CheckInOptions) =>
      getCheckoutRepository().checkIn(checkoutId, options),
    onSettled: () => invalidateBorrowing(client),
  });
}

/**
 * Renew an open loan by changing its due date in place (B3). Invalidates the same views as a
 * check-in — the open-loan list re-renders with the new date (and its overdue flag), and the
 * due date shifts any accrue-mode maintenance telemetry — without ending the loan.
 */
export function useRenewLoan() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ checkoutId, dueDate }: { checkoutId: string; dueDate: number | null }) =>
      getCheckoutRepository().renew(checkoutId, { dueDate }),
    onSettled: () => invalidateBorrowing(client),
  });
}
