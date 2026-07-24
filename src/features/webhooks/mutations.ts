/**
 * Write-side hooks for webhook subscriptions (webhooks plan `W7`).
 *
 * Kept in a separate module from `queries.ts` on purpose: component tests `vi.mock` the queries
 * module wholesale, and a mutation co-located there would resolve to `undefined` at every call
 * site. See the same split in `features/suppliers`.
 */
import { useMutation, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { getWebhookRepository, type CreateWebhookInput, type UpdateWebhookInput } from '@/db/repositories';
import { useReportWriteFailure } from '@/features/errors';
import { webhookKeys } from './queries';

function invalidateWebhookConsumers(client: QueryClient): void {
  void client.invalidateQueries({ queryKey: webhookKeys.all });
}

export function useCreateWebhook() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateWebhookInput) => getWebhookRepository().create(input),
    onSuccess: () => invalidateWebhookConsumers(client),
  });
}

export function useUpdateWebhook() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ id, input }: { readonly id: string; readonly input: UpdateWebhookInput }) =>
      getWebhookRepository().update(id, input),
    onSuccess: () => invalidateWebhookConsumers(client),
  });
}

export function useDeleteWebhook() {
  const client = useQueryClient();
  const reportFailure = useReportWriteFailure('webhooks.writeError.heading.delete', 'common.writeFailed');
  return useMutation({
    mutationFn: (id: string) => getWebhookRepository().delete(id),
    // A rejected write would otherwise fail silently, so surface it to the user (#389).
    onError: reportFailure,
    onSuccess: () => invalidateWebhookConsumers(client),
  });
}
