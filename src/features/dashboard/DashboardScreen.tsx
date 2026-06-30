import { cn } from '@/lib/utils';
import { LiveRegion, MAIN_CONTENT_ID, PageContainer } from '@/components/foundry';
import { BrandMark } from '@/components/BrandMark';
import { ExternalLinkIcon } from '@/components/icons';
import { APP_VERSION, APP_RELEASE_DATE } from '@/lib/app-version';
import { useAlerts } from '@/features/alerts/useAlerts';
import { usePreferencesStore } from '@/state/stores/usePreferencesStore';
import { useWakeLock } from './useWakeLock';
import { DashboardGrid } from './DashboardGrid';
import { DashboardNav } from './DashboardNav';
import { DashboardActions } from './DashboardActions';
import { DashboardGettingStarted } from './DashboardGettingStarted';

/** The public GitHub repository — the brand hero links here on the landing page. */
const REPO_URL = 'https://github.com/BootBlock/Gubbins';

/** Build/release date formatted once for display (the constant never changes at runtime). */
const RELEASE_LABEL = new Intl.DateTimeFormat(undefined, {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
}).format(new Date(`${APP_RELEASE_DATE}T00:00:00`));

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
          className="group flex items-center gap-4 rounded-2xl outline-none focus-visible:ring-2 focus-visible:ring-primary"
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
            which has no version slot). */}
        <dl className="ml-auto text-right text-xs leading-tight text-muted-foreground">
          <dt className="sr-only">Version</dt>
          <dd className="font-medium tabular-nums text-foreground">v{APP_VERSION}</dd>
          <dt className="sr-only">Released</dt>
          <dd className="tabular-nums">{RELEASE_LABEL}</dd>
        </dl>
      </header>

      {/* Hero toolbar: quick search (command palette) + Add item / Scan quick actions,
          each independently toggleable from Settings → Dashboard. */}
      <DashboardActions />

      {/* First-run guidance — self-hides once the inventory has any items. */}
      <DashboardGettingStarted />

      <LiveRegion visuallyHidden>
        {alertCount > 0 ? `${alertCount} item${alertCount === 1 ? '' : 's'} need attention` : ''}
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
