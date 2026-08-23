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
 * It composes `PageHeader` over the shared `Interstitial` primitive, exactly as the Modular UI's
 * "module hidden" screen does, so the global nav and skip-link wiring survive the refusal.
 */
import type { ReactNode } from 'react';
import { Link, useRouterState } from '@tanstack/react-router';
import { ROUTE_PERMISSIONS } from '@/components/nav/nav-destinations';
import { Button, Interstitial, PageContainer, PageHeader } from '@/components/foundry';
import { BlockedIcon, HomeIcon } from '@/components/icons';
import { useT } from '@/features/i18n';
import type { PermissionKey } from './permission-registry';
import { permissionLabelKeys } from './permission-labels';
import { usePermission } from './usePermission';

export interface PermissionGuardProps {
  /**
   * The read permission this screen requires; sourced from the nav registry. Several mean **any**
   * of them suffices, and the refusal names the first — the one an operator is most likely to
   * have meant to grant.
   */
  readonly permission: PermissionKey | readonly PermissionKey[];
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
  // Several keys mean any one would do; the refusal names the first, which is the one an
  // operator is most likely to have meant to grant.
  const named = typeof permission === 'string' ? permission : permission[0];
  if (named === undefined) return <>{children}</>;
  return <PermissionDeniedInterstitial permission={named} />;
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
  if (!permission || permission.length === 0) return <>{children}</>;
  return <PermissionGuard permission={permission}>{children}</PermissionGuard>;
}

/**
 * Reduce a location pathname to the registry's key form.
 *
 * Two normalisations, both of which a hand-typed or shared URL will otherwise walk straight
 * through:
 *
 * - **Case.** TanStack matches static segments case-insensitively unless a route opts out, and
 *   Gubbins does not, so `/Activity` renders the Activity screen — while `location.pathname`
 *   keeps the casing that was typed. An exact lookup would miss and the gate would open. Every
 *   registry path is already lower-case, so lower-casing here is lossless.
 * - **Trailing slash.** The router does not add one, but a pasted URL can carry it, and
 *   `/inventory/` must not slip past a gate `/inventory` holds.
 */
function normalisePath(pathname: string): string {
  const lowered = pathname.toLowerCase();
  const trimmed = lowered.length > 1 ? lowered.replace(/\/+$/, '') : lowered;
  return trimmed || '/';
}

/** The in-place "your role doesn't allow this" screen. */
function PermissionDeniedInterstitial({ permission }: { readonly permission: PermissionKey }) {
  const t = useT();
  const [subjectKey, actionKey] = permissionLabelKeys(permission);

  return (
    <PageContainer>
      <PageHeader icon={<BlockedIcon />} title={t('permission.denied.title')} />

      <Interstitial
        icon={<BlockedIcon />}
        heading={t('permission.denied.heading')}
        body={[
          t('permission.denied.body', {
            vars: { permission: `${t(subjectKey)} · ${t(actionKey)}` },
          }),
          t('permission.denied.ask'),
        ]}
        actions={
          <Button asChild>
            <Link to="/">
              <HomeIcon aria-hidden />
              {t('permission.denied.home')}
            </Link>
          </Button>
        }
      />
    </PageContainer>
  );
}
