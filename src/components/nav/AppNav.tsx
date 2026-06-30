import { Fragment } from 'react';
import { useRouterState } from '@tanstack/react-router';
import { Menu, MenuLink, MenuSeparator } from '@/components/foundry';
import { MenuIcon } from '@/components/icons';
import { useAlerts } from '@/features/alerts/useAlerts';
import { NAV_DESTINATIONS, NAV_GROUP_ORDER, type NavGroup } from './nav-destinations';

/**
 * AppNav — the global navigation menu, rendered by {@link PageHeader} on every screen
 * (spec §2.4.2). A single "Menu" button opens a grouped list of *every* destination,
 * so any screen can reach any other — fixing the old headers, which each exposed an
 * ad-hoc handful of links and left whole screens (About, Settings…) unreachable from
 * places like Inventory. The current route is marked `aria-current`, and the Alerts
 * row carries a live badge of undismissed alerts.
 */
export function AppNav() {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const { alerts } = useAlerts();
  const alertCount = alerts.length;

  return (
    <Menu
      label="Navigation menu"
      align="end"
      triggerProps={{ 'data-testid': 'app-nav' }}
      trigger={
        <span className="relative flex items-center gap-2">
          <MenuIcon />
          <span className="hidden sm:inline">Menu</span>
          {alertCount > 0 && (
            <span
              aria-hidden
              className="absolute -right-2.5 -top-2.5 flex size-4 items-center justify-center rounded-full bg-destructive text-[10px] font-bold text-destructive-foreground"
              data-testid="app-nav-alert-badge"
            >
              {alertCount > 99 ? '99+' : alertCount}
            </span>
          )}
        </span>
      }
    >
      {NAV_GROUP_ORDER.map((group: NavGroup, groupIndex) => (
        <Fragment key={group}>
          {groupIndex > 0 && <MenuSeparator />}
          {NAV_DESTINATIONS.filter((d) => d.group === group).map((dest) => (
            <MenuLink
              key={dest.to}
              to={dest.to}
              icon={<dest.Icon />}
              current={pathname === dest.to}
              trailing={
                dest.to === '/alerts' && alertCount > 0 ? (
                  <span
                    className="ml-auto flex h-5 min-w-5 items-center justify-center rounded-full bg-destructive px-1.5 text-[10px] font-bold text-destructive-foreground"
                    data-testid="app-nav-alerts-count"
                  >
                    {alertCount > 99 ? '99+' : alertCount}
                  </span>
                ) : undefined
              }
            >
              {dest.label}
            </MenuLink>
          ))}
        </Fragment>
      ))}
    </Menu>
  );
}
