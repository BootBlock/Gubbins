import { useEffect } from 'react';
import { plural } from '@/lib/plural';
import { cn } from '@/lib/utils';
import { LiveRegion, MAIN_CONTENT_ID, PageContainer } from '@/components/foundry';
import { BrandMark } from '@/components/BrandMark';
import { AppNav } from '@/components/nav/AppNav';
import { ExternalLinkIcon } from '@/components/icons';
import { useAlerts } from '@/features/alerts/useAlerts';
import { usePreferencesStore } from '@/state/stores/usePreferencesStore';
import { useWakeLock } from './useWakeLock';
import { useDashboardCustomise } from './useDashboardCustomise';
import { DashboardGrid } from './DashboardGrid';
import { DashboardNav } from './DashboardNav';
import { DashboardActions } from './DashboardActions';
import { DashboardGettingStarted } from './DashboardGettingStarted';
import { DashboardBackupNudge } from './DashboardBackupNudge';
import { DashboardBanner } from './DashboardBanner';
import { DashboardVersion } from './DashboardVersion';

/** The public GitHub repository — the brand hero links here on the landing page. */
const REPO_URL = 'https://github.com/BootBlock/Gubbins';

/**
 * Landing screen — the §3 customisable widget board. The fixed status cards of the
 * earlier phases are now pinnable widgets in {@link DashboardGrid} (drag-and-drop +
 * keyboard reorder, show/hide, persisted to `useLayoutStore`). The header is the brand
 * hero; the grouped destination tiles live in {@link DashboardNav} below it.
 */
export function DashboardScreen() {
  const kioskMode = usePreferencesStore((state) => state.kioskMode);

  // §3 Kiosk & Tablet Ergonomics: keep a hardwired dashboard awake while kiosk mode
  // is on (feature-detected, graceful). The matching touch/selection containment is
  // applied to the content landmark below.
  useWakeLock(kioskMode);

  // "Customise" is a momentary rearranging mode, not a preference: leave it behind when the
  // user navigates away from the dashboard, so returning lands on the normal (view) hub.
  useEffect(() => () => useDashboardCustomise.getState().setEditing(false), []);

  // Announce the number of items needing attention (low stock, expiring, overdue, …) so a
  // change while the dashboard is open isn't a silent, visual-only badge update (WCAG
  // 4.1.3). The badge in the nav carries the visible count; this is the announce-only twin.
  const { alerts } = useAlerts();
  const alertCount = alerts.length;

  return (
    <PageContainer>
      <header className="flex flex-wrap items-center gap-4">
        {/* On the landing page the brand hero doubles as a link to the public GitHub
            repository (opens in a new tab) — a deliberate exception to the other screens'
            home-link brand mark, which this screen doesn't have. */}
        <a
          href={REPO_URL}
          target="_blank"
          rel="noreferrer"
          aria-label="Open the Gubbins GitHub repository (opens in a new tab)"
          className="group flex items-center gap-4 rounded-2xl outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
        >
          <BrandMark className="size-12 rounded-2xl transition-transform duration-200 ease-emphasized group-hover:-translate-y-0.5" />
          <div>
            <span className="flex items-center gap-2">
              <h1 className="bg-gradient-to-br from-foreground to-foreground/60 bg-clip-text text-2xl font-semibold tracking-tight text-transparent">
                Gubbins
              </h1>
              <ExternalLinkIcon
                aria-hidden
                className="size-4 text-muted-foreground opacity-0 transition-opacity duration-200 group-hover:opacity-100"
              />
            </span>
            <p className="text-sm text-muted-foreground">Local-first inventory · your dashboard</p>
          </div>
        </a>

        {/* Version + release date — landing-page only (the other screens use PageHeader,
            which has no version slot). Clicking it runs a manual update check. Pushed to the
            far right with its own `ml-auto`; the header's `items-center` then vertically
            centres it against the brand hero, so it lines up with the "Gubbins" title + its
            sub-header rather than floating at the top edge. The pre-1.0 warning banner that
            used to sit here has moved down beside the backup nudge (see below). */}
        <DashboardVersion />
      </header>

      {/* Hero toolbar: quick search (command palette) + Add item / Scan quick actions on the
          left (each independently toggleable from Settings → Dashboard), with the global
          navigation menu pinned to the right of the same row. AppNav is rendered here rather
          than inside DashboardActions so the menu is always present — even when both hero
          affordances are toggled off and DashboardActions renders nothing. */}
      <div className="flex flex-wrap items-center gap-2">
        <DashboardActions />
        {/* `ml-auto` pushes the menu to the far right of the toolbar row, mirroring the
            top-right slot AppNav occupies via PageHeader on every other screen. */}
        <div className="ml-auto">
          <AppNav />
        </div>
      </div>

      {/* First-run guidance — self-hides once the inventory has any items. */}
      <DashboardGettingStarted />

      {/* Notices row — two side-by-side columns on wide screens, stacked on narrow ones:
          the data-safety backup nudge (first column) and the pre-1.0 work-in-progress
          warning (second column). Each self-gates (the nudge hides once there's a sync
          provider / no data / dismissed; the WIP banner hides at 1.0 or once dismissed via
          its close button), and `lg:flex-1` makes whichever remains grow to fill the row,
          so a single surviving notice never sits at half width. `lg:items-start` lets the
          two columns keep their own natural heights rather than stretching to match, and
          `empty:hidden` collapses the whole row (no stray PageContainer gap) when both
          notices have gated themselves off. */}
      <div className="flex flex-col gap-4 empty:hidden lg:flex-row lg:items-start">
        <DashboardBackupNudge className="lg:flex-1" />
        <DashboardBanner className="lg:flex-1" />
      </div>

      <LiveRegion visuallyHidden>
        {alertCount > 0 ? `${alertCount} ${plural(alertCount, 'item')} need attention` : ''}
      </LiveRegion>

      {/* The landing hub shows every destination as a grouped tile grid, mapped from the
          same NAV_DESTINATIONS source of truth the global AppNav menu uses on every other
          screen — so the two can never drift. */}
      <DashboardNav />

      <main
        id={MAIN_CONTENT_ID}
        tabIndex={-1}
        data-kiosk={kioskMode ? 'on' : undefined}
        className={cn('outline-none', kioskMode && 'touch-pan-y select-none')}
      >
        <DashboardGrid />
      </main>
    </PageContainer>
  );
}
