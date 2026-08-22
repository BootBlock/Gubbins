import { Fragment } from 'react';
import { useRouterState } from '@tanstack/react-router';
import { Kbd, Menu, MenuLink, MenuAction, MenuExternalLink, MenuSeparator } from '@/components/foundry';
import { MenuIcon, WikiIcon, ExternalLinkIcon, SignOutIcon } from '@/components/icons';
import { useAlerts } from '@/features/alerts/useAlerts';
import { useEnabledFeatures, useFeature } from '@/features/modules/useFeature';
import { useSignOut } from '@/features/users/useSignOut';
import { useSessionStore } from '@/state/stores/useSessionStore';
import { useHotkeyHints } from '@/features/hotkeys/useHotkeyHints';
import { useSettingsDialog } from '@/features/settings/useSettingsDialog';
import { useT } from '@/features/i18n';
import { NAV_DESTINATIONS, NAV_GROUP_ORDER } from './nav-destinations';

/**
 * A row's bound shortcut, printed the way a desktop menu prints its accelerators (issue #127).
 *
 * Decorative: the row's own label already names the action, and the menu item is reachable by
 * keyboard regardless — announcing "G then R" to a screen-reader user stepping through the menu
 * would be noise at exactly the wrong moment. Renders nothing when the row has no shortcut.
 */
function NavShortcutHint({ binding }: { readonly binding: string | undefined }) {
  if (binding === undefined) return null;
  return (
    <span aria-hidden data-testid="app-nav-shortcut">
      <Kbd>{binding}</Kbd>
    </span>
  );
}

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
  const t = useT();
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const { alerts } = useAlerts();
  const alertCount = alerts.length;
  const enabledFeatures = useEnabledFeatures();
  const openSettings = useSettingsDialog((s) => s.openSettings);
  const hints = useHotkeyHints();

  // Drop rows whose feature is switched off, then discard any group left with no rows so no
  // empty section — or the separator that would precede it — is rendered (§3, Phase 2). Core
  // destinations are `alwaysOn`, so they always survive the filter.
  const visibleGroups = NAV_GROUP_ORDER.map((group) => ({
    group,
    destinations: NAV_DESTINATIONS.filter((d) => d.group === group && enabledFeatures.has(d.feature)),
  })).filter((g) => g.destinations.length > 0);

  return (
    <Menu
      label={t('nav.menuLabel')}
      align="end"
      triggerProps={{ 'data-testid': 'app-nav' }}
      trigger={
        <span className="relative flex items-center gap-2">
          <MenuIcon />
          <span className="hidden sm:inline">{t('nav.menu')}</span>
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
              {dest.to === '/settings' ? (
                // Settings is a dialog, not a screen: open it over the current route rather
                // than navigating (a link would also prefetch-open it on hover). See
                // `useSettingsDialog` / `SettingsDialogHost`.
                <MenuAction
                  icon={<dest.Icon />}
                  onSelect={openSettings}
                  data-testid="app-nav-settings"
                  trailing={<NavShortcutHint binding={hints.forCommand('open-settings')} />}
                >
                  {t(dest.messageKey)}
                </MenuAction>
              ) : (
                <MenuLink
                  to={dest.to}
                  icon={<dest.Icon />}
                  current={pathname === dest.to}
                  trailing={
                    // The alert count and the accelerator can both apply to the same row, so
                    // they share the slot rather than one hiding the other.
                    <span className="ml-auto flex items-center gap-1.5">
                      {dest.to === '/alerts' && alertCount > 0 ? (
                        <span
                          className="flex h-5 min-w-5 items-center justify-center rounded-full bg-destructive px-1.5 text-[10px] font-bold text-destructive-foreground"
                          data-testid="app-nav-alerts-count"
                        >
                          {alertCount > 99 ? '99+' : alertCount}
                        </span>
                      ) : null}
                      <NavShortcutHint binding={hints.forRoute(dest.to)} />
                    </span>
                  }
                >
                  {t(dest.messageKey)}
                </MenuLink>
              )}
              {/* Wiki (external) sits directly under Settings, above About. */}
              {dest.to === '/settings' && (
                <MenuExternalLink
                  href={WIKI_URL}
                  icon={<WikiIcon />}
                  trailing={<ExternalLinkIcon className="ml-auto opacity-60" aria-hidden />}
                  data-testid="app-nav-wiki"
                >
                  {t('nav.wiki')}
                </MenuExternalLink>
              )}
            </Fragment>
          ))}
        </Fragment>
      ))}

      <SignOutRow />
    </Menu>
  );
}

/**
 * The way out, for when somebody is signed in (issue #79, plan §3).
 *
 * Renders nothing at all while the users module is off, which is the state Gubbins ships in —
 * there is nobody to sign out as, and offering it would introduce the concept to people who
 * have never met it.
 *
 * It lives here rather than on the Users screen because signing out is not administration: on a
 * shared device it is the thing the *current* person does when they walk away, and it has to be
 * reachable from wherever they happen to be standing.
 */
function SignOutRow() {
  const moduleEnabled = useFeature('users');
  const session = useSessionStore((state) => state.session);

  if (!moduleEnabled || !session) return null;
  return <SignOutMenuItem displayName={session.displayName} />;
}

/**
 * Split from {@link SignOutRow} so that `useSignOut` — and through it `useQueryClient` — is only
 * called on the branch that actually renders. Calling it unconditionally would make *every*
 * consumer of `AppNav`, which `PageHeader` mounts on every screen, require a `QueryClientProvider`
 * even in single-user mode, where this row does not exist. The module being off must add no
 * dependency the app did not already have.
 */
function SignOutMenuItem({ displayName }: { readonly displayName: string }) {
  const t = useT();
  const signOut = useSignOut();

  return (
    <>
      <MenuSeparator />
      <MenuAction icon={<SignOutIcon />} data-testid="app-nav-sign-out" onSelect={() => void signOut()}>
        {t('nav.signOut', { vars: { name: displayName } })}
      </MenuAction>
    </>
  );
}
