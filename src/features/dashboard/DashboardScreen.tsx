import { Link } from '@tanstack/react-router';
import { cn } from '@/lib/utils';
import { buttonVariants, MAIN_CONTENT_ID } from '@/components/foundry';
import { BrandMark } from '@/components/BrandMark';
import { NAV_DESTINATIONS } from '@/components/nav/nav-destinations';
import { usePreferencesStore } from '@/state/stores/usePreferencesStore';
import { useWakeLock } from './useWakeLock';
import { DashboardGrid } from './DashboardGrid';
import { useAlerts } from '@/features/alerts/useAlerts';

/**
 * Landing screen — the §3 customisable widget board. The fixed status cards of the
 * earlier phases are now pinnable widgets in {@link DashboardGrid} (drag-and-drop +
 * keyboard reorder, show/hide, persisted to `useLayoutStore`); the header keeps the
 * brand and the primary quick-nav.
 */
export function DashboardScreen() {
  const kioskMode = usePreferencesStore((state) => state.kioskMode);

  // §3 Kiosk & Tablet Ergonomics: keep a hardwired dashboard awake while kiosk mode
  // is on (feature-detected, graceful). The matching touch/selection containment is
  // applied to the content landmark below.
  useWakeLock(kioskMode);

  // Alert badge: count of undismissed alerts for the nav entry.
  const { alerts: activeAlerts } = useAlerts();
  const alertCount = activeAlerts.length;

  return (
    <div className="mx-auto w-full max-w-6xl px-4 pb-16 pt-6">
      <header className="flex flex-wrap items-center gap-4">
        <BrandMark className="size-12 rounded-2xl" />
        <div>
          <h1 className="bg-gradient-to-br from-foreground to-foreground/60 bg-clip-text text-2xl font-semibold tracking-tight text-transparent">
            Gubbins
          </h1>
          <p className="text-sm text-muted-foreground">Local-first inventory · your dashboard</p>
        </div>
        {/* The landing hub shows every destination as a visible tile, mapped from the same
            NAV_DESTINATIONS source of truth the global AppNav menu uses on every other
            screen — so the two can never drift. Inventory is the primary call-to-action;
            the Alerts tile carries the live badge. */}
        <nav aria-label="Primary navigation" className="ml-auto flex flex-wrap items-center gap-2">
          {NAV_DESTINATIONS.filter((dest) => dest.to !== '/').map((dest) => {
            const isInventory = dest.to === '/inventory';
            const isAlerts = dest.to === '/alerts';
            return (
              <Link
                key={dest.to}
                to={dest.to}
                className={cn(
                  buttonVariants({ variant: isInventory ? 'primary' : 'outline' }),
                  isAlerts && 'relative',
                )}
                aria-label={
                  isAlerts && alertCount > 0
                    ? `Alerts — ${alertCount} active alert${alertCount === 1 ? '' : 's'}`
                    : undefined
                }
                data-testid={isAlerts ? 'nav-alerts' : undefined}
              >
                <dest.Icon />
                {isInventory ? 'Open inventory' : dest.label}
                {isAlerts && alertCount > 0 && (
                  <span
                    aria-hidden
                    className="absolute -right-1.5 -top-1.5 flex size-5 items-center justify-center rounded-full bg-destructive text-[10px] font-bold text-destructive-foreground"
                    data-testid="alerts-badge"
                  >
                    {alertCount > 99 ? '99+' : alertCount}
                  </span>
                )}
              </Link>
            );
          })}
        </nav>
      </header>

      <main
        id={MAIN_CONTENT_ID}
        tabIndex={-1}
        data-kiosk={kioskMode ? 'on' : undefined}
        className={cn('outline-none', kioskMode && 'touch-pan-y select-none')}
      >
        <DashboardGrid />
      </main>
    </div>
  );
}
