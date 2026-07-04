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
import { plural } from '@/lib/plural';
import { cn } from '@/lib/utils';
import { NAV_OPEN_DELAY_MS, Surface, Tooltip } from '@/components/foundry';
import {
  NAV_DESTINATIONS,
  NAV_GROUP_ORDER,
  type AppRoutePath,
  type NavGroup,
} from '@/components/nav/nav-destinations';
import { useAlerts } from '@/features/alerts/useAlerts';
import { useEnabledFeatures } from '@/features/modules/useFeature';
import { useSettingsDialog } from '@/features/settings/useSettingsDialog';
import { NAV_COUNT_NOUNS, useNavCounts } from './useNavCounts';

/** Human-facing heading per nav group (the SSOT keys are terse identifiers). */
const GROUP_LABELS: Record<NavGroup, string> = {
  primary: 'Workspaces',
  manage: 'Manage',
  system: 'System',
};

/**
 * A whisper-faint background wash per group, so the three columns read as distinct
 * regions at a glance. Each is a theme-aware token at extremely low opacity (no colour
 * literals): primary violet for the everyday workspaces, accent cyan for the manage
 * column, and a rose-red hue for the system column. Rose comes from the decorative
 * location palette rather than `destructive`, so it reads as a distinct colour without
 * implying a danger/error state.
 */
const GROUP_TINTS: Record<NavGroup, string> = {
  primary: 'bg-primary/5',
  manage: 'bg-accent/5',
  system: 'bg-loc-rose/[0.06]',
};

/**
 * Translucent, group-coloured background for the cards themselves (the non-CTA tiles),
 * a touch deeper than the panel wash so each tile lifts off its panel while still letting
 * the tint beneath show through. Same theme-aware tokens as {@link GROUP_TINTS}; the
 * Surface's own `backdrop-blur` frosts it for a glassy, tinted look. The Inventory tile is
 * exempt — it keeps its solid primary call-to-action fill.
 */
const GROUP_CARD_TINTS: Record<NavGroup, string> = {
  primary: 'bg-primary/10 hover:bg-primary/15',
  manage: 'bg-accent/10 hover:bg-accent/15',
  system: 'bg-loc-rose/10 hover:bg-loc-rose/15',
};

/**
 * Count-pill colours per group (see {@link useNavCounts}) — the group's own hue as text on a
 * soft same-hue wash, so the number reads as a distinct, quick-to-scan accent against the
 * card's title without looking like the destructive Alerts badge. The Inventory tile is the
 * solid-primary CTA, so its pill instead sits on the inverse `primary-foreground` (handled at
 * the call site). Same theme-aware tokens as the card tints, dark-mode-correct for free.
 */
const GROUP_COUNT_BADGE: Record<NavGroup, string> = {
  primary: 'bg-primary/15 text-primary',
  manage: 'bg-accent/15 text-accent',
  system: 'bg-loc-rose/15 text-loc-rose',
};

/**
 * Rich-Markdown blurb for each destination's hover tooltip — what you'll find behind the
 * card. Keyed by route so it stays aligned with {@link NAV_DESTINATIONS}; the dashboard
 * (`/`) is the current screen and never appears as a tile, and `/modules` is reached from
 * Settings/first-run rather than a nav tile — so neither has an entry.
 */
const NAV_TOOLTIPS: Record<Exclude<AppRoutePath, '/' | '/modules'>, string> = {
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
  '/home-assistant':
    '**Home Assistant** — voice control setup.\n\nAn interactive, step-by-step guide to ask **“where are my …?”** from Home Assistant — run the bridge, connect it, and generate an access token.',
  '/settings':
    '**Settings** — preferences.\n\nTheme, currency & locale, scanner options, low-stock thresholds, kiosk mode and the rest of the app’s behaviour.',
  '/about':
    '**About** — app & storage info.\n\nVersion, storage usage, platform capabilities and project information.',
};

export function DashboardNav() {
  // Alert badge: count of undismissed alerts for the Alerts tile.
  const { alerts } = useAlerts();
  const alertCount = alerts.length;
  const enabledFeatures = useEnabledFeatures();
  const openSettings = useSettingsDialog((s) => s.openSettings);
  // Per-destination "how many are in there" counts for the collection tiles (Inventory,
  // Projects, …). A route absent from the map — or sitting at 0 — shows no pill.
  const navCounts = useNavCounts();

  return (
    <nav aria-label="Primary navigation" className="grid grid-cols-1 gap-x-4 gap-y-6 sm:grid-cols-3">
      {NAV_GROUP_ORDER.map((group) => {
        // The dashboard itself is the current screen, so it never appears as a tile; a tile
        // whose feature is switched off is dropped too. An empty group collapses (returns
        // null), so no bare heading is left behind.
        const destinations = NAV_DESTINATIONS.filter(
          (dest) => dest.group === group && dest.to !== '/' && enabledFeatures.has(dest.feature),
        );
        if (destinations.length === 0) return null;

        return (
          <section
            key={group}
            aria-label={GROUP_LABELS[group]}
            className={cn('rounded-2xl p-3', GROUP_TINTS[group])}
          >
            <h2 className="mb-3 px-1 text-sm font-semibold text-muted-foreground">{GROUP_LABELS[group]}</h2>
            <ul className="grid grid-cols-2 gap-3">
              {destinations.map((dest) => {
                const isInventory = dest.to === '/inventory';
                const isAlerts = dest.to === '/alerts';
                // Settings is a dialog, not a screen: its tile opens the dialog over the
                // dashboard rather than navigating (and a Link would prefetch-open it on
                // hover). See `useSettingsDialog` / `SettingsDialogHost`.
                const isSettings = dest.to === '/settings';
                // Collection count for this tile (Inventory/Projects/…); undefined or 0 ⇒ no pill.
                const count = navCounts[dest.to];
                const showCount = typeof count === 'number' && count > 0;
                // Spoken form of the count for the tile's accessible name — a bare "3" next to
                // "Projects" is ambiguous, so name it ("Projects — 3 active projects").
                const countLabel =
                  showCount && count !== undefined
                    ? `${isInventory ? 'Open inventory' : dest.label} — ${count} ${plural(
                        count,
                        NAV_COUNT_NOUNS[dest.to] ?? 'item',
                      )}`
                    : undefined;
                const surface = (
                  <Surface
                    className={cn(
                      'relative flex h-full items-center gap-2.5 p-3 transition-all duration-200 ease-emphasized hover:-translate-y-0.5 [&_svg]:size-5 [&_svg]:shrink-0',
                      isInventory
                        ? 'border-transparent bg-primary text-primary-foreground shadow-primary/20 hover:shadow-primary/30'
                        : cn('hover:shadow-primary/10', GROUP_CARD_TINTS[group]),
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
                    {/* Collection count pill — right-aligned, group-coloured, capped so a huge
                        catalogue can't stretch the tile. The spoken count rides on the tile's
                        aria-label below, so the pill itself is decorative. */}
                    {showCount && count !== undefined && (
                      <span
                        aria-hidden
                        data-testid={`nav-count-${dest.to}`}
                        className={cn(
                          'ml-auto inline-flex h-5 min-w-5 items-center justify-center rounded-full px-1.5 text-xs font-semibold tabular-nums',
                          isInventory
                            ? 'bg-primary-foreground/15 text-primary-foreground'
                            : GROUP_COUNT_BADGE[group],
                        )}
                      >
                        {count > 999 ? '999+' : count}
                      </span>
                    )}
                  </Surface>
                );
                const tileClassName =
                  'block h-full w-full rounded-2xl text-left outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50';
                return (
                  <li key={dest.to}>
                    <Tooltip
                      content={NAV_TOOLTIPS[dest.to as keyof typeof NAV_TOOLTIPS]}
                      triggerTabIndex={-1}
                      openDelayMs={NAV_OPEN_DELAY_MS}
                      className="block h-full"
                    >
                      {isSettings ? (
                        <button
                          type="button"
                          data-testid="nav-settings"
                          onClick={openSettings}
                          className={tileClassName}
                        >
                          {surface}
                        </button>
                      ) : (
                        <Link
                          to={dest.to}
                          data-testid={isAlerts ? 'nav-alerts' : undefined}
                          aria-label={
                            isAlerts && alertCount > 0
                              ? `Alerts — ${alertCount} active ${plural(alertCount, 'alert')}`
                              : countLabel
                          }
                          className={tileClassName}
                        >
                          {surface}
                        </Link>
                      )}
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
