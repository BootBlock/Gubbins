import { createRootRoute, Outlet } from '@tanstack/react-router';
import { SkipLink } from '@/components/foundry';
import { BackgroundEffects } from '@/components/background/BackgroundEffects';
import { StorageBanners } from '@/features/storage/StorageBanners';
import { OfflineIndicator } from '@/components/OfflineIndicator';
import { CommandPalette } from '@/features/command-palette/CommandPalette';
import { FirstRunModules } from '@/features/modules/FirstRunModules';
import { SettingsDialogHost } from '@/features/settings/SettingsDialogHost';
import { useGlobalHotkeys } from '@/features/hotkeys/useGlobalHotkeys';
import { cn } from '@/lib/utils';
import { usePreferencesStore } from '@/state/stores/usePreferencesStore';

/**
 * Root route layout (spec §2.4.2). Hosts the always-visible app chrome — the
 * skip-to-content bypass, the storage warning stack, the offline indicator, the
 * one-time Modular UI first-run chooser and the app-wide Settings dialog — above the
 * routed content. The {@link SkipLink} is the first focusable element on every route;
 * each screen carries the `#main-content` landmark it targets (spec §3 — WCAG 2.4.1).
 * Settings lives here (rather than a screen) so it can open over any route while still
 * resolving its links to Modules / About. The global keyboard shortcuts (issue #32) are bound
 * here for the same reason: this is the one component mounted on every route.
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
  // Keep the storage-banner stack aligned with the page frame's width: it normally shares the
  // `max-w-6xl` cap so the banners line up with the content beneath, and follows the same
  // Full-width opt-out (issue #14) so they widen together rather than the banners staying in a
  // narrow centred column while the page fills the viewport.
  const fullWidth = usePreferencesStore((s) => s.fullWidth);
  // The app's single document-level keyboard-shortcut listener (issue #32) — here because the
  // root layout is the one component mounted on every route, and the shortcuts are global.
  useGlobalHotkeys();
  // `isolate` makes this element the stacking context the fixed background-effects canvas belongs
  // to, so its `-z-10` paints *above* this element's opaque `bg-background` (a stacking context
  // paints negative-z-index children after its own background) yet still below all content. Without
  // it the canvas escapes to the root context and the opaque background paints over it, hiding the
  // effect entirely — the same reason the About starfield's container is `relative isolate`.
  return (
    <div className="isolate min-h-dvh bg-background text-foreground">
      {/* Decorative animated weather layer, behind all content (opt-in; renders nothing when off). */}
      <BackgroundEffects />
      <SkipLink />
      <div
        className={cn(
          'print-hide mx-auto w-full px-4 pt-4 empty:hidden',
          fullWidth ? 'max-w-none' : 'max-w-6xl',
        )}
      >
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
