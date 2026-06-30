import { Link } from '@tanstack/react-router';
import { cn } from '@/lib/utils';
import { buttonVariants, Tooltip, MAIN_CONTENT_ID } from '@/components/foundry';
import { PackageIcon, ProjectIcon, CloudIcon, SettingsIcon, InfoIcon, ReportIcon, ShoppingCartIcon, AlertIcon, DueDateIcon, BookingIcon, HistoryIcon } from '@/components/icons';
import { BrandMark } from '@/components/BrandMark';
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
        <Tooltip content="About Gubbins — version, links, author and licence." triggerTabIndex={-1} className="ml-auto">
          <Link
            to="/about"
            aria-label="About"
            className={cn(buttonVariants({ variant: 'outline', size: 'icon' }))}
          >
            <InfoIcon />
          </Link>
        </Tooltip>
        <Tooltip content="App preferences — theme, currency, scanner, storage and more." triggerTabIndex={-1}>
          <Link
            to="/settings"
            aria-label="Settings"
            className={cn(buttonVariants({ variant: 'outline', size: 'icon' }))}
          >
            <SettingsIcon />
          </Link>
        </Tooltip>
        <Link to="/sync" className={cn(buttonVariants({ variant: 'outline' }))}>
          <CloudIcon />
          Sync
        </Link>
        <Link to="/projects" className={cn(buttonVariants({ variant: 'outline' }))}>
          <ProjectIcon />
          Projects
        </Link>
        <Link to="/purchase-orders" className={cn(buttonVariants({ variant: 'outline' }))}>
          <ShoppingCartIcon />
          Purchase orders
        </Link>
        <Link to="/reports" className={cn(buttonVariants({ variant: 'outline' }))}>
          <ReportIcon />
          Reports
        </Link>
        <Link to="/upcoming" className={cn(buttonVariants({ variant: 'outline' }))}>
          <DueDateIcon />
          Upcoming
        </Link>
        <Link to="/bookings" className={cn(buttonVariants({ variant: 'outline' }))}>
          <BookingIcon />
          Bookings
        </Link>
        <Link to="/activity" className={cn(buttonVariants({ variant: 'outline' }))}>
          <HistoryIcon />
          Activity
        </Link>
        <Link
          to="/alerts"
          className={cn(buttonVariants({ variant: 'outline' }), 'relative')}
          aria-label={
            alertCount > 0
              ? `Alerts — ${alertCount} active alert${alertCount === 1 ? '' : 's'}`
              : 'Alerts'
          }
          data-testid="nav-alerts"
        >
          <AlertIcon />
          Alerts
          {alertCount > 0 && (
            <span
              aria-hidden
              className="absolute -right-1.5 -top-1.5 flex size-5 items-center justify-center rounded-full bg-destructive text-[10px] font-bold text-destructive-foreground"
              data-testid="alerts-badge"
            >
              {alertCount > 99 ? '99+' : alertCount}
            </span>
          )}
        </Link>
        <Link to="/inventory" className={cn(buttonVariants())}>
          <PackageIcon />
          Open inventory
        </Link>
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
