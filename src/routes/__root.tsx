import { createRootRoute, Outlet } from '@tanstack/react-router';
import { SkipLink } from '@/components/foundry';
import { StorageBanners } from '@/features/storage/StorageBanners';
import { OfflineIndicator } from '@/components/OfflineIndicator';
import { PwaUpdatePrompt } from '@/components/PwaUpdatePrompt';

/**
 * Root route layout (spec §2.4.2). Hosts the always-visible app chrome — the
 * skip-to-content bypass, the storage warning stack, the offline indicator and the
 * PWA "new version ready" update prompt — above the routed content. The {@link SkipLink} is the first focusable element on
 * every route; each screen carries the `#main-content` landmark it targets (spec §3
 * — WCAG 2.4.1).
 */
export const Route = createRootRoute({
  component: RootLayout,
});

function RootLayout() {
  return (
    <div className="min-h-dvh bg-background text-foreground">
      <SkipLink />
      <div className="mx-auto w-full max-w-6xl px-4 pt-4 empty:hidden">
        <StorageBanners />
      </div>
      <Outlet />
      <OfflineIndicator />
      <PwaUpdatePrompt />
    </div>
  );
}
