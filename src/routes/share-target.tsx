import { createFileRoute } from '@tanstack/react-router';
import { ShareTargetScreen } from '@/features/share/ShareTargetScreen';

/**
 * Web Share Target landing route (plan EI-4). The service worker redirects an inbound
 * "Share to Gubbins" POST here as a GET carrying a one-shot `?share=<id>` for the stashed payload.
 */
export const Route = createFileRoute('/share-target')({
  validateSearch: (search: Record<string, unknown>): { share?: string } => ({
    share: typeof search.share === 'string' ? search.share : undefined,
  }),
  component: RouteComponent,
});

function RouteComponent() {
  const { share } = Route.useSearch();
  return <ShareTargetScreen shareId={share} />;
}
