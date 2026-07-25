/**
 * Query-key SSOT for the contacts dictionary and the checkout (borrowing) records.
 *
 * Split out of `./contacts` — the read/write hook module — so the write sites that reshape a
 * loan without belonging to this domain can name the prefix instead of spelling it as a string
 * literal: converting a booking, deleting a location, deleting a project all return the tools
 * still out and so must refresh these views. Importing the hook module for a key would drag in
 * the repositories (and, worse, resolve to `undefined` in the several component tests that
 * `vi.mock('@/features/contacts/contacts')`), which is exactly why `['checkouts']` was being
 * re-typed at each of those sites (issue #379).
 */

export const contactKeys = {
  all: ['contacts'] as const,
  list: () => [...contactKeys.all, 'list'] as const,
  /**
   * One page of the contacts dictionary. Nested **under** {@link contactKeys.list} so every
   * existing `invalidateQueries` against the list (or `all`) still refreshes every page and
   * the count.
   */
  page: (offset: number, limit: number) => [...contactKeys.list(), { offset, limit }] as const,
  count: () => [...contactKeys.list(), 'count'] as const,
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
