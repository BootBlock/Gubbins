import { createRootRoute, Outlet } from '@tanstack/react-router';
import { StorageBanners } from '@/features/storage/StorageBanners';

/**
 * Root route layout (spec §2.4.2). Hosts the always-visible app chrome — currently
 * the storage warning stack — above the routed content.
 */
export const Route = createRootRoute({
  component: RootLayout,
});

function RootLayout() {
  return (
    <div className="min-h-dvh bg-background text-foreground">
      <div className="mx-auto w-full max-w-6xl px-4 pt-4 empty:hidden">
        <StorageBanners />
      </div>
      <Outlet />
    </div>
  );
}
