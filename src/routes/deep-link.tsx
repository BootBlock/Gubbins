import { createFileRoute } from '@tanstack/react-router';
import { DeepLinkScreen } from '@/features/share/DeepLinkScreen';

/**
 * `web+gubbins:` protocol-handler landing route (plan EI-4). The OS routes a `web+gubbins://…`
 * deep link here with the raw link url-encoded in `?target=`.
 */
export const Route = createFileRoute('/deep-link')({
  validateSearch: (search: Record<string, unknown>): { target?: string } => ({
    target: typeof search.target === 'string' ? search.target : undefined,
  }),
  component: RouteComponent,
});

function RouteComponent() {
  const { target } = Route.useSearch();
  return <DeepLinkScreen target={target} />;
}
