import { Fragment } from 'react';
import { useRouterState } from '@tanstack/react-router';
import { Menu, MenuLink, MenuExternalLink, MenuSeparator } from '@/components/foundry';
import { MenuIcon, WikiIcon, ExternalLinkIcon } from '@/components/icons';
import { useAlerts } from '@/features/alerts/useAlerts';
import { useEnabledFeatures } from '@/features/modules/useFeature';
import { NAV_DESTINATIONS, NAV_GROUP_ORDER } from './nav-destinations';

/**
 * The project wiki — help, tips and support. It lives on GitHub, so it is an external
 * link rather than a {@link NAV_DESTINATIONS} route (which are all in-app screens), and
 * is injected into the System group between Settings and About.
 */
const WIKI_URL = 'https://github.com/BootBlock/Gubbins/wiki';

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
  const enabledFeatures = useEnabledFeatures();

  // Drop rows whose feature is switched off, then discard any group left with no rows so no
  // empty section — or the separator that would precede it — is rendered (§3, Phase 2). Core
  // destinations are `alwaysOn`, so they always survive the filter.
  const visibleGroups = NAV_GROUP_ORDER.map((group) => ({
    group,
    destinations: NAV_DESTINATIONS.filter((d) => d.group === group && enabledFeatures.has(d.feature)),
  })).filter((g) => g.destinations.length > 0);

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
      {visibleGroups.map(({ group, destinations }, groupIndex) => (
        <Fragment key={group}>
          {groupIndex > 0 && <MenuSeparator />}
          {destinations.map((dest) => (
            <Fragment key={dest.to}>
              <MenuLink
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
              {/* Wiki (external) sits directly under Settings, above About. */}
              {dest.to === '/settings' && (
                <MenuExternalLink
                  href={WIKI_URL}
                  icon={<WikiIcon />}
                  trailing={<ExternalLinkIcon className="ml-auto opacity-60" aria-hidden />}
                  data-testid="app-nav-wiki"
                >
                  Wiki
                </MenuExternalLink>
              )}
            </Fragment>
          ))}
        </Fragment>
      ))}
    </Menu>
  );
}
