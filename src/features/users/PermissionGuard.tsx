/**
 * Route guard + "you don't have permission" interstitial (issue #522).
 *
 * The Users module always enforced *writes* at the repository layer and left reads open, which
 * left the built-in roles saying one thing and the app doing another: a Viewer is described as
 * someone who cannot see the activity history or the user accounts, and both screens opened
 * normally. The Bridge already refused the same account the same data over HTTP.
 *
 * This closes that at the screen boundary. {@link RoutePermissionGuard} is mounted **once**, in
 * the root layout around the `<Outlet />`, and looks the current path up in `ROUTE_PERMISSIONS`
 * — so a denied account cannot reach the screen by typing its URL, and a screen added later is
 * gated by its registry row rather than by remembering to wrap one more route file. Hiding the
 * navigation row alone would not be a check.
 *
 * Two things it deliberately is not:
 *
 * - **Not row-level filtering.** A screen the account may open shows everything that screen
 *   shows. Gating every list and search query is a different and much larger change; the honest
 *   statement is that permissions govern screens and actions, and the wiki says exactly that.
 * - **Not a lock on the data.** The database is local and readable by anyone holding the
 *   device (plan §1.1). This gates the application.
 *
 * It composes {@link PageHeader} and its own `<main>` exactly as {@link ModuleGuard} does, so
 * the global nav and skip-link wiring survive the interstitial.
 */
import type { ReactNode } from 'react';
import { Link, useRouterState } from '@tanstack/react-router';
import { ROUTE_PERMISSIONS, type AppRoutePath } from '@/components/nav/nav-destinations';
import { Button, PageContainer, PageHeader, Surface, MAIN_CONTENT_ID } from '@/components/foundry';
import { BlockedIcon, HomeIcon } from '@/components/icons';
import { useT } from '@/features/i18n';
import type { PermissionKey } from './permission-registry';
import { permissionLabelKeys } from './permission-labels';
import { usePermission } from './usePermission';

export interface PermissionGuardProps {
  /** The read permission this screen requires; sourced from the nav registry. */
  readonly permission: PermissionKey;
  /** The screen to render when the session holds it. */
  readonly children: ReactNode;
}

/**
 * Gate a screen behind a read permission. Transparent when the session holds it — which is
 * every session in single-user mode, where the authority resolves unrestricted.
 */
export function PermissionGuard({ permission, children }: PermissionGuardProps) {
  const allowed = usePermission(permission);
  if (allowed) return <>{children}</>;
  return <PermissionDeniedInterstitial permission={permission} />;
}

/**
 * Gate the routed screen behind whatever read permission its path declares.
 *
 * Mounted once in the root layout, so every route is covered by the one registry lookup. A path
 * with no `ROUTE_PERMISSIONS` entry renders untouched.
 */
export function RoutePermissionGuard({ children }: { readonly children: ReactNode }) {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const permission = ROUTE_PERMISSIONS.get(normalisePath(pathname));
  if (!permission) return <>{children}</>;
  return <PermissionGuard permission={permission}>{children}</PermissionGuard>;
}

/**
 * Reduce a location pathname to the registry's key form. The router does not add a trailing
 * slash, but a hand-typed or shared URL can carry one, and `/inventory/` must not slip past a
 * gate `/inventory` holds.
 */
function normalisePath(pathname: string): AppRoutePath {
  const trimmed = pathname.length > 1 ? pathname.replace(/\/+$/, '') : pathname;
  return (trimmed || '/') as AppRoutePath;
}

/** The in-place "your role doesn't allow this" screen. */
function PermissionDeniedInterstitial({ permission }: { readonly permission: PermissionKey }) {
  const t = useT();
  const [subjectKey, actionKey] = permissionLabelKeys(permission);

  return (
    <PageContainer>
      <PageHeader icon={<BlockedIcon />} title={t('permission.denied.title')} />

      <main
        id={MAIN_CONTENT_ID}
        tabIndex={-1}
        className="flex flex-1 animate-rise flex-col items-center justify-center py-10 outline-none"
      >
        <Surface className="flex max-w-md flex-col items-center gap-4 p-8 text-center">
          <span
            aria-hidden
            className="flex size-12 items-center justify-center rounded-full bg-secondary text-muted-foreground [&_svg]:size-6"
          >
            <BlockedIcon />
          </span>
          <div className="flex flex-col gap-1.5">
            <h2 className="text-lg font-semibold text-foreground">{t('permission.denied.heading')}</h2>
            <p className="text-sm text-muted-foreground">
              {t('permission.denied.body', {
                vars: { permission: `${t(subjectKey)} · ${t(actionKey)}` },
              })}
            </p>
            <p className="text-sm text-muted-foreground">{t('permission.denied.ask')}</p>
          </div>
          <Button asChild>
            <Link to="/">
              <HomeIcon aria-hidden />
              {t('permission.denied.home')}
            </Link>
          </Button>
        </Surface>
      </main>
    </PageContainer>
  );
}
