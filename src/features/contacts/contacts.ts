/**
 * Tier-1 hooks for the contacts & checkout domain (spec §2.1, §4 Borrowing).
 *
 * Reads go through TanStack Query. Checkout/check-in writes touch the item table
 * (on-hand quantity) and the Activity Ledger as well as the checkout records, so
 * they invalidate `inventoryKeys.items()` alongside the contact/checkout keys.
 * These are deliberately invalidation-based rather than optimistically patched: a
 * single confirmation tap is low-frequency (the *rapid* path is the scanner queue,
 * which batches and commits via these same mutations). Lists are bounded per
 * contact/item and capped at 100 per the strict-pagination mandate (§2.1) — so the Contacts
 * screen pages the dictionary server-side rather than showing that one capped read as if it
 * were every contact (issue #149).
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  getCheckoutRepository,
  getContactRepository,
  MAX_PAGE_SIZE,
  type CheckInOptions,
  type CheckoutItemInput,
  type CreateContactInput,
  type UpdateContactInput,
} from '@/db/repositories';
import { inventoryKeys } from '@/features/inventory/queries';
import { nowMs } from '@/lib/clock';
import { invalidateItems } from '@/features/inventory/invalidate';
import { useReportWriteFailure } from '@/features/errors';
import { checkoutKeys, contactKeys } from './keys';

// --- reads ---------------------------------------------------------------------

/**
 * One page of the contacts dictionary (issue #149).
 *
 * Defaults to the first full page, which is what every caller read before — only the Contacts
 * screen passes a page. The name pickers that also use this (checking out, booking an asset)
 * are suggestion lists over free text: a name past the first page can still simply be typed,
 * and is resolved or created by name, so the cap costs a suggestion there rather than access.
 */
export function useContacts(page = 1, pageSize = MAX_PAGE_SIZE) {
  const limit = Math.max(1, Math.min(MAX_PAGE_SIZE, Math.floor(pageSize)));
  const offset = Math.max(0, (Math.max(1, Math.floor(page)) - 1) * limit);
  return useQuery({
    queryKey: contactKeys.page(offset, limit),
    queryFn: () => getContactRepository().list({ limit, offset }),
    // Hold the previous page on screen while the next one loads, so paging doesn't flash the
    // empty state (the Tags screen's behaviour).
    placeholderData: (previous) => previous,
  });
}

/** How many contacts exist in total — the denominator for the dictionary's pager. */
export function useContactCount() {
  return useQuery({
    queryKey: contactKeys.count(),
    queryFn: () => getContactRepository().count(),
  });
}

export function useOpenCheckouts() {
  return useQuery({
    queryKey: checkoutKeys.open(),
    queryFn: () => getCheckoutRepository().listOpen({ limit: 100 }),
  });
}

/**
 * How many loans are open, and how many of those are overdue — the totals behind
 * {@link useOpenCheckouts}'s single bounded page (issue #606).
 *
 * The Dashboard's Overdue widget and the Contacts "On loan" summary both state a figure over
 * that page. Counting its rows capped both at the page size, and made "N still on loan" the
 * remainder of a page rather than of the board. `nowMs()` is read once per mount, as the other
 * `now`-dependent feeds do, so the figure is stable for the life of the query entry.
 */
export function useOpenCheckoutCounts() {
  const now = nowMs();
  return useQuery({
    queryKey: checkoutKeys.openCount(),
    queryFn: () => getCheckoutRepository().countOpen(now),
  });
}

/**
 * One page of the open-loans list, for the export's read-everything walk (issue #132). The
 * screen's own read is capped at a single 100-row page, so serialising the rows in hand would
 * quietly stop at 100 loans; the export re-reads from the start through `exportEveryPage`.
 * Not a hook — it is called from the export's `build` callback, outside React's render.
 */
export function readOpenCheckoutsPage(params: { limit: number; offset: number }) {
  return getCheckoutRepository().listOpen(params);
}

/** One page of the contacts dictionary, for the export's read-everything walk (issue #132). */
export function readContactsPage(params: { limit: number; offset: number }) {
  return getContactRepository().list(params);
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
