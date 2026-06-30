/**
 * DashboardNav — the landing hub's primary navigation, laid out as grouped tiles.
 *
 * Every destination is shown as a compact card tile (icon + label) — roughly half the
 * footprint of the widget cards below — arranged into the same `primary` / `manage` /
 * `system` groups the global {@link AppNav} menu uses, so the two can never drift (both
 * read the {@link NAV_DESTINATIONS} source of truth). Inventory is the primary
 * call-to-action; the Alerts tile carries the live badge. Replaces the old right-aligned
 * wrapping button row, which packed the destinations into a ragged, hard-to-scan strip.
 */
import { Link } from '@tanstack/react-router';
import { cn } from '@/lib/utils';
import { Surface } from '@/components/foundry';
import {
  NAV_DESTINATIONS,
  NAV_GROUP_ORDER,
  type NavGroup,
} from '@/components/nav/nav-destinations';
import { useAlerts } from '@/features/alerts/useAlerts';

/** Human-facing heading per nav group (the SSOT keys are terse identifiers). */
const GROUP_LABELS: Record<NavGroup, string> = {
  primary: 'Workspaces',
  manage: 'Manage',
  system: 'System',
};

export function DashboardNav() {
  // Alert badge: count of undismissed alerts for the Alerts tile.
  const { alerts } = useAlerts();
  const alertCount = alerts.length;

  return (
    <nav aria-label="Primary navigation" className="flex flex-col gap-6">
      {NAV_GROUP_ORDER.map((group) => {
        // The dashboard itself is the current screen, so it never appears as a tile.
        const destinations = NAV_DESTINATIONS.filter(
          (dest) => dest.group === group && dest.to !== '/',
        );
        if (destinations.length === 0) return null;

        return (
          <section key={group} aria-label={GROUP_LABELS[group]}>
            <h2 className="mb-3 text-sm font-semibold text-muted-foreground">
              {GROUP_LABELS[group]}
            </h2>
            <ul className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-6">
              {destinations.map((dest) => {
                const isInventory = dest.to === '/inventory';
                const isAlerts = dest.to === '/alerts';
                return (
                  <li key={dest.to}>
                    <Link
                      to={dest.to}
                      data-testid={isAlerts ? 'nav-alerts' : undefined}
                      aria-label={
                        isAlerts && alertCount > 0
                          ? `Alerts — ${alertCount} active alert${alertCount === 1 ? '' : 's'}`
                          : undefined
                      }
                      className="block h-full rounded-2xl outline-none focus-visible:ring-2 focus-visible:ring-primary"
                    >
                      <Surface
                        className={cn(
                          'relative flex h-full flex-col items-center justify-center gap-2 p-3 text-center transition-all duration-200 ease-emphasized hover:-translate-y-0.5 [&_svg]:size-6',
                          isInventory
                            ? 'border-transparent bg-primary text-primary-foreground shadow-primary/20 hover:shadow-primary/30'
                            : 'hover:shadow-primary/10',
                        )}
                      >
                        <dest.Icon aria-hidden />
                        <span className="text-sm font-medium">
                          {isInventory ? 'Open inventory' : dest.label}
                        </span>
                        {isAlerts && alertCount > 0 && (
                          <span
                            aria-hidden
                            data-testid="alerts-badge"
                            className="absolute right-2 top-2 flex size-5 items-center justify-center rounded-full bg-destructive text-[10px] font-bold text-destructive-foreground"
                          >
                            {alertCount > 99 ? '99+' : alertCount}
                          </span>
                        )}
                      </Surface>
                    </Link>
                  </li>
                );
              })}
            </ul>
          </section>
        );
      })}
    </nav>
  );
}
