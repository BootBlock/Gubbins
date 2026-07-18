/**
 * Read-side hooks for webhook subscriptions (webhooks plan `W7`).
 *
 * Components never touch a repository directly (spec §2.1) — they go through these hooks, and
 * through the separate `mutations.ts` for writes. The split is load-bearing rather than tidy:
 * component tests `vi.mock` this module wholesale, so a mutation co-located here would resolve to
 * `undefined` in every screen test.
 */
import { useQuery } from '@tanstack/react-query';
import { getWebhookRepository } from '@/db/repositories';

export const webhookKeys = {
  all: ['webhooks'] as const,
  list: () => [...webhookKeys.all, 'list'] as const,
  detail: (id: string) => [...webhookKeys.all, 'detail', id] as const,
} as const;

/**
 * Every configured subscription. The list is small by nature — a webhook is a deliberate,
 * hand-made thing, not a record type that accumulates — so it is fetched in one page.
 */
export function useWebhooks() {
  return useQuery({
    queryKey: webhookKeys.list(),
    queryFn: () => getWebhookRepository().list({ limit: 100 }),
    staleTime: 60_000,
  });
}
