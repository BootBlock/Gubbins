/**
 * Component tests for the read-permission route guard (issue #522).
 *
 * The gap this closes was silent by construction: `assertPermission` guards writes, so a role
 * with no `audit:view` was refused nothing it could reach through a screen, and `/activity`
 * rendered the whole ledger. These assert the three states that matter — unrestricted renders
 * the screen, a granted key renders the screen, a withheld key renders the interstitial instead
 * — plus that the guard reads the *route registry* rather than a second list of its own, which
 * is what stops a screen being hidden from the nav while still answering to its URL.
 *
 * Dependencies are stubbed at the module boundary so the header renders without a router or a
 * QueryClient (the foundry-page-header convention `ModuleGuard.test.tsx` already follows).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';

let pathname = '/activity';

// Plain-anchor Link + a settable pathname, so PageHeader and the guard render without a router.
vi.mock('@tanstack/react-router', () => ({
  Link: ({ children, to, ...props }: { children: React.ReactNode; to: string; [k: string]: unknown }) => (
    <a href={to} {...props}>
      {children}
    </a>
  ),
  useRouterState: ({ select }: { select: (s: { location: { pathname: string } }) => unknown }) =>
    select({ location: { pathname } }),
}));

vi.mock('@/components/BrandMark', () => ({
  BrandMark: () => <span data-testid="brand-mark" />,
}));

vi.mock('@/components/nav/AppNav', () => ({
  AppNav: () => <button type="button" data-testid="app-nav" aria-label="Navigation menu" />,
}));

vi.mock('@/features/command-palette/HeaderSearch', () => ({
  HeaderSearch: () => <button type="button" data-testid="header-search" />,
}));

vi.mock('@/components/icons', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/components/icons')>();
  return Object.fromEntries(Object.keys(actual).map((k) => [k, () => <span data-testid={`icon-${k}`} />]));
});

import { PermissionGuard, RoutePermissionGuard } from './PermissionGuard';
import { ROUTE_PERMISSIONS } from '@/components/nav/nav-destinations';
import { useSessionStore } from '@/state/stores/useSessionStore';
import { UNRESTRICTED_AUTHORITY } from './permissions';
import { ADMIN_USER_ID } from '@/db/repositories/constants';

/** Put the session on a `granted` authority holding exactly `grants`. */
function grant(...grants: readonly string[]) {
  useSessionStore.setState({ authority: { mode: 'granted', grants: new Set(grants) } });
}

beforeEach(() => {
  pathname = '/activity';
  useSessionStore.setState({ authority: UNRESTRICTED_AUTHORITY, actorId: ADMIN_USER_ID });
});
afterEach(() => {
  cleanup();
  useSessionStore.setState({ authority: UNRESTRICTED_AUTHORITY, actorId: ADMIN_USER_ID });
});

/** The real screen the guard wraps, tagged so we can assert whether it rendered. */
function Screen() {
  return <div data-testid="real-screen">The real screen</div>;
}

describe('PermissionGuard', () => {
  it('renders the screen untouched in single-user mode (unrestricted authority)', () => {
    render(
      <PermissionGuard permission="audit:view">
        <Screen />
      </PermissionGuard>,
    );
    expect(screen.getByTestId('real-screen')).toBeTruthy();
  });

  it('renders the screen when the role grants the key', () => {
    grant('audit:view');
    render(
      <PermissionGuard permission="audit:view">
        <Screen />
      </PermissionGuard>,
    );
    expect(screen.getByTestId('real-screen')).toBeTruthy();
  });

  it('renders the interstitial (not the screen) when the role withholds the key', () => {
    grant('items:read');
    render(
      <PermissionGuard permission="audit:view">
        <Screen />
      </PermissionGuard>,
    );

    expect(screen.queryByTestId('real-screen')).toBeNull();
    expect(screen.getByRole('heading', { name: 'Your role doesn’t allow this' })).toBeTruthy();
    // Names the permission in the operator's own vocabulary, not the raw key.
    expect(screen.getByText(/Activity history · View/)).toBeTruthy();
    expect(screen.getByRole('link', { name: /back to the dashboard/i }).getAttribute('href')).toBe('/');
  });

  it('denies a signed-out or role-less session, whose authority grants nothing', () => {
    useSessionStore.setState({ authority: { mode: 'denied', reason: 'no-role' } });
    render(
      <PermissionGuard permission="users:read">
        <Screen />
      </PermissionGuard>,
    );
    expect(screen.queryByTestId('real-screen')).toBeNull();
  });
});

describe('RoutePermissionGuard', () => {
  it('gates the routed screen on the permission its path declares', () => {
    pathname = '/users';
    grant('items:read');
    render(
      <RoutePermissionGuard>
        <Screen />
      </RoutePermissionGuard>,
    );
    expect(screen.queryByTestId('real-screen')).toBeNull();
    expect(screen.getByText(/Users and roles · View/)).toBeTruthy();
  });

  it('renders a path that declares no permission untouched', () => {
    pathname = '/about';
    grant();
    render(
      <RoutePermissionGuard>
        <Screen />
      </RoutePermissionGuard>,
    );
    expect(screen.getByTestId('real-screen')).toBeTruthy();
  });

  it('does not let a trailing slash walk around the gate', () => {
    pathname = '/activity/';
    grant('items:read');
    render(
      <RoutePermissionGuard>
        <Screen />
      </RoutePermissionGuard>,
    );
    expect(screen.queryByTestId('real-screen')).toBeNull();
  });

  /**
   * The router matches static segments case-insensitively, and `location.pathname` keeps the
   * casing that was typed — so an exact-case registry lookup opened the gate for anyone who
   * typed `/Activity`. The screen renders either way; only the guard's lookup was fooled.
   */
  it('does not let a differently-cased URL walk around the gate', () => {
    pathname = '/Activity';
    grant('items:read');
    render(
      <RoutePermissionGuard>
        <Screen />
      </RoutePermissionGuard>,
    );
    expect(screen.queryByTestId('real-screen')).toBeNull();
  });

  /**
   * `/deep-link` is the `web+gubbins:` protocol-handler landing. It has no nav row and no palette
   * entry, so nothing hides it — and it opens an item's full detail dialog, which is the record
   * `/inventory` shows. A URL arriving from outside the app is exactly the door a hidden nav row
   * does not close.
   */
  it('gates the off-nav routes that render a gated subject', () => {
    pathname = '/deep-link';
    grant('projects:read');
    render(
      <RoutePermissionGuard>
        <Screen />
      </RoutePermissionGuard>,
    );
    expect(screen.queryByTestId('real-screen')).toBeNull();
  });
});

describe('ROUTE_PERMISSIONS — the promises the wiki makes', () => {
  it('gates the two screens the built-in Viewer role is described as not seeing', () => {
    expect(ROUTE_PERMISSIONS.get('/activity')).toBe('audit:view');
    expect(ROUTE_PERMISSIONS.get('/users')).toBe('users:read');
  });

  it('keys every entry in lower case, so a differently-cased URL still resolves', () => {
    for (const path of ROUTE_PERMISSIONS.keys()) expect(path).toBe(path.toLowerCase());
  });

  it('leaves the ways back from a restricted session ungated', () => {
    // The dashboard is where the interstitial sends people, Modules is how a hidden feature
    // comes back, and About/Settings are this device's own information and preferences. A gate
    // on any of them could strand an account with nowhere to go.
    for (const path of ['/', '/about', '/modules', '/settings'] as const) {
      expect(ROUTE_PERMISSIONS.has(path)).toBe(false);
    }
  });
});
