import { createRootRoute, Outlet } from '@tanstack/react-router';
import { SkipLink } from '@/components/foundry';
import { StorageBanners } from '@/features/storage/StorageBanners';
import { OfflineIndicator } from '@/components/OfflineIndicator';
import { CommandPalette } from '@/features/command-palette/CommandPalette';
import { FirstRunModules } from '@/features/modules/FirstRunModules';
import { SettingsDialogHost } from '@/features/settings/SettingsDialogHost';

/**
 * Root route layout (spec §2.4.2). Hosts the always-visible app chrome — the
 * skip-to-content bypass, the storage warning stack, the offline indicator, the
 * one-time Modular UI first-run chooser and the app-wide Settings dialog — above the
 * routed content. The {@link SkipLink} is the first focusable element on every route;
 * each screen carries the `#main-content` landmark it targets (spec §3 — WCAG 2.4.1).
 * Settings lives here (rather than a screen) so it can open over any route while still
 * resolving its links to Modules / About.
 *
 * The PWA "new version ready" update prompt is NOT here — this layout only mounts once
 * <BootGate> reaches `ready`, but service-worker registration must happen regardless of
 * boot state (it's what supplies the COOP/COEP headers BootGate's cross-origin-isolation
 * check depends on). See its sibling-of-BootGate placement in {@link ../App}.
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
      <CommandPalette />
      <FirstRunModules />
      <SettingsDialogHost />
    </div>
  );
}
