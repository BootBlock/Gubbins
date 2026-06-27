/**
 * Tier-1 data layer: the TanStack Query client (spec §2.1).
 *
 * Defaults tuned for a local-first app where the SQLite worker is the source of
 * truth: queries are cheap and local, so a short staleTime plus targeted cache
 * invalidation (rather than window-focus refetching) keeps the UI in step with
 * optimistic writes. A factory so tests can spin up isolated clients.
 */
import { QueryClient } from '@tanstack/react-query';

export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 30_000,
        gcTime: 5 * 60_000,
        retry: 1,
        refetchOnWindowFocus: false,
      },
      mutations: {
        retry: 0,
      },
    },
  });
}
