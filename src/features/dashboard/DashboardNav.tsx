/**
 * DashboardNav — the landing hub's primary navigation, laid out as grouped tiles.
 *
 * The destinations are arranged as **three side-by-side columns**, one per nav group
 * (`primary` / `manage` / `system`), with each group's cards stacked within its column.
 * The grouping is the same {@link NAV_DESTINATIONS} source of truth the global
 * {@link AppNav} menu reads, so the hub and the menu can never drift. Inventory is the
 * primary call-to-action; the Alerts tile carries the live badge. Each card has a rich
 * Markdown {@link Tooltip} explaining what that destination contains. Replaces the old
 * right-aligned wrapping button row, which packed everything into a ragged strip.
 */
import { Link } from '@tanstack/react-router';
import { cn } from '@/lib/utils';
import { NAV_OPEN_DELAY_MS, Surface, Tooltip } from '@/components/foundry';
import {
  NAV_DESTINATIONS,
  NAV_GROUP_ORDER,
  type AppRoutePath,
  type NavGroup,
} from '@/components/nav/nav-destinations';
import { useAlerts } from '@/features/alerts/useAlerts';

/** Human-facing heading per nav group (the SSOT keys are terse identifiers). */
const GROUP_LABELS: Record<NavGroup, string> = {
  primary: 'Workspaces',
  manage: 'Manage',
  system: 'System',
};

/**
 * Rich-Markdown blurb for each destination's hover tooltip — what you'll find behind the
 * card. Keyed by route so it stays aligned with {@link NAV_DESTINATIONS}; the dashboard
 * (`/`) is the current screen and never appears as a tile, so it has no entry.
 */
const NAV_TOOLTIPS: Record<Exclude<AppRoutePath, '/'>, string> = {
  '/inventory':
    '**Inventory** — your item catalogue.\n\nBrowse, search and filter every item, adjust stock by location, scan barcodes, and manage categories, locations, batches and cycle counts.',
  '/projects':
    '**Projects** — build & job workspaces.\n\nTrack each project’s bill of materials, reserve and consume stock, manage a **budget** with an expense ledger, and follow its status.',
  '/purchase-orders':
    '**Purchase orders** — procurement.\n\nRaise and receive POs against your suppliers, handle **partial / split receipts**, and watch in-transit stock land back in inventory.',
  '/reports':
    '**Reports** — analytics & insight.\n\nStock valuation, **ABC analysis**, turnover & aging, spend over time, supplier costs and a data-hygiene checklist — all exportable to CSV.',
  '/contacts':
    '**Contacts** — people & suppliers.\n\nYour address book of suppliers and contacts, with their linked **supplier parts**, pricing and price history.',
  '/bookings':
    '**Bookings** — reserve assets ahead.\n\nWhole-day reservations of bookable items shown on a calendar, with overlap checks and one-click **convert to checkout**.',
  '/upcoming':
    '**Upcoming** — your agenda.\n\nEvery date-driven event — due maintenance, expiring stock, bookings and PO deliveries — gathered into one timeline, **bucketed by when** it’s due.',
  '/activity':
    '**Activity** — the global timeline.\n\nA read-only feed of **every change across all items**, newest first, with filters by action type.',
  '/alerts':
    '**Alerts** — what needs attention.\n\nLow-stock, expiring, overdue and **budget** warnings gathered into one actionable list. The badge shows how many are active.',
  '/sync':
    '**Sync** — cloud backup & devices.\n\nBack up and restore your vault, and **sync changes between devices** so your inventory follows you.',
  '/settings':
    '**Settings** — preferences.\n\nTheme, currency & locale, scanner options, low-stock thresholds, kiosk mode and the rest of the app’s behaviour.',
  '/about':
    '**About** — app & storage info.\n\nVersion, storage usage, platform capabilities and project information.',
};

export function DashboardNav() {
  // Alert badge: count of undismissed alerts for the Alerts tile.
  const { alerts } = useAlerts();
  const alertCount = alerts.length;

  return (
    <nav
      aria-label="Primary navigation"
      className="grid grid-cols-1 gap-x-4 gap-y-6 sm:grid-cols-3"
    >
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
            <ul className="grid grid-cols-2 gap-3">
              {destinations.map((dest) => {
                const isInventory = dest.to === '/inventory';
                const isAlerts = dest.to === '/alerts';
                return (
                  <li key={dest.to}>
                    <Tooltip
                      content={NAV_TOOLTIPS[dest.to as keyof typeof NAV_TOOLTIPS]}
                      triggerTabIndex={-1}
                      openDelayMs={NAV_OPEN_DELAY_MS}
                      className="block h-full"
                    >
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
                            'relative flex h-full items-center gap-2.5 p-3 transition-all duration-200 ease-emphasized hover:-translate-y-0.5 [&_svg]:size-5 [&_svg]:shrink-0',
                            isInventory
                              ? 'border-transparent bg-primary text-primary-foreground shadow-primary/20 hover:shadow-primary/30'
                              : 'hover:shadow-primary/10',
                          )}
                        >
                          <dest.Icon aria-hidden />
                          <span className="min-w-0 text-sm font-medium leading-tight">
                            {isInventory ? 'Open inventory' : dest.label}
                          </span>
                          {isAlerts && alertCount > 0 && (
                            <span
                              aria-hidden
                              data-testid="alerts-badge"
                              className="ml-auto flex size-5 items-center justify-center rounded-full bg-destructive text-[10px] font-bold text-destructive-foreground"
                            >
                              {alertCount > 99 ? '99+' : alertCount}
                            </span>
                          )}
                        </Surface>
                      </Link>
                    </Tooltip>
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
