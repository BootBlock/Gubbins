/**
 * Component tests for the route guard + "module hidden" interstitial (modular-ui-plan §4,
 * Phase 5).
 *
 * Covers the four behaviours the guard owns: a hidden feature renders the interstitial (not
 * the screen); **Show this module** flips intent on and reveals the screen (offering the
 * dependency cascade when the feature has off dependencies); **Continue anyway** renders the
 * screen once without touching intent; and an on feature renders the children untouched. A
 * final structural check asserts every optional page route wraps its screen in the guard
 * while the core/utility routes never do. Dependencies are stubbed at the module boundary so
 * the header renders without a router/QueryClient (foundry-page-header convention); the
 * cascade Modal is click-driven per the component-test conventions.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';

// Plain-anchor Link so PageHeader / the "Manage modules" link render without a RouterProvider.
vi.mock('@tanstack/react-router', () => ({
  Link: ({ children, to, ...props }: { children: React.ReactNode; to: string; [k: string]: unknown }) => (
    <a href={to} {...props}>
      {children}
    </a>
  ),
}));

vi.mock('@/components/BrandMark', () => ({
  BrandMark: () => <span data-testid="brand-mark" />,
}));

// The global nav menu has its own suite; stub it (foundry-page-header convention).
vi.mock('@/components/nav/AppNav', () => ({
  AppNav: () => <button type="button" data-testid="app-nav" aria-label="Navigation menu" />,
}));

// The header's command-palette search pulls the preferences store — stub it out.
vi.mock('@/features/command-palette/HeaderSearch', () => ({
  HeaderSearch: () => <button type="button" data-testid="header-search" />,
}));

// Render every icon as a text-free span so heading/label text stays clean.
vi.mock('@/components/icons', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/components/icons')>();
  return Object.fromEntries(Object.keys(actual).map((k) => [k, () => <span data-testid={`icon-${k}`} />]));
});

import { ModuleGuard } from './ModuleGuard';
import { useModulesStore } from '@/state/stores/useModulesStore';
import { useSessionStore } from '@/state/stores/useSessionStore';
import { UNRESTRICTED_AUTHORITY } from '@/features/users/permissions';

beforeEach(() => {
  useModulesStore.setState({ intent: {}, firstRunComplete: false });
  useSessionStore.setState({ authority: UNRESTRICTED_AUTHORITY });
});
afterEach(() => {
  cleanup();
  useModulesStore.setState({ intent: {}, firstRunComplete: false });
  useSessionStore.setState({ authority: UNRESTRICTED_AUTHORITY });
});

/** The real screen the guard wraps, tagged so we can assert whether it rendered. */
function Screen() {
  return <div data-testid="real-screen">The real screen</div>;
}

describe('ModuleGuard — hidden feature', () => {
  it('renders the interstitial (not the screen) when the feature is off', () => {
    useModulesStore.setState({ intent: { projects: false } });
    render(
      <ModuleGuard feature="projects">
        <Screen />
      </ModuleGuard>,
    );

    expect(screen.getByRole('heading', { name: 'Projects is hidden' })).toBeTruthy();
    expect(screen.queryByTestId('real-screen')).toBeNull();
    // Offers a quiet way to the manager.
    expect(screen.getByRole('link', { name: /manage modules/i }).getAttribute('href')).toBe('/modules');
  });
});

describe('ModuleGuard — Show this module', () => {
  it('flips the feature intent on and reveals the screen (no dependencies)', () => {
    useModulesStore.setState({ intent: { projects: false } });
    render(
      <ModuleGuard feature="projects">
        <Screen />
      </ModuleGuard>,
    );

    fireEvent.click(screen.getByTestId('module-guard-show'));

    expect(useModulesStore.getState().intent.projects).toBe(true);
    expect(screen.getByTestId('real-screen')).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'Projects is hidden' })).toBeNull();
  });

  it('confirms and enables missing dependencies before revealing the screen', () => {
    // Purchase orders depends on contacts; both off, so showing PO must pull contacts on too.
    useModulesStore.setState({ intent: { 'purchase-orders': false, contacts: false } });
    render(
      <ModuleGuard feature="purchase-orders">
        <Screen />
      </ModuleGuard>,
    );

    fireEvent.click(screen.getByTestId('module-guard-show'));

    // A confirmation naming the pulled-in dependency appears; intent is NOT yet mutated.
    const dialog = screen.getByRole('dialog', { name: 'Show Purchase orders?' });
    expect(dialog.textContent).toContain('Contacts');
    expect(useModulesStore.getState().intent['purchase-orders']).toBe(false);
    expect(screen.queryByTestId('real-screen')).toBeNull();

    fireEvent.click(screen.getByTestId('confirm-cascade'));

    const intent = useModulesStore.getState().intent;
    expect(intent['purchase-orders']).toBe(true);
    expect(intent.contacts).toBe(true);
    expect(screen.getByTestId('real-screen')).toBeTruthy();
  });
});

describe('ModuleGuard — Continue anyway', () => {
  it('renders the screen once without changing intent', () => {
    useModulesStore.setState({ intent: { projects: false } });
    render(
      <ModuleGuard feature="projects">
        <Screen />
      </ModuleGuard>,
    );

    fireEvent.click(screen.getByTestId('module-guard-continue'));

    expect(screen.getByTestId('real-screen')).toBeTruthy();
    // Intent is untouched — the module stays hidden everywhere else.
    expect(useModulesStore.getState().intent.projects).toBe(false);
  });
});

describe('ModuleGuard — enabled feature', () => {
  it('renders the children untouched, with no interstitial', () => {
    // Default intent → every feature on.
    render(
      <ModuleGuard feature="projects">
        <Screen />
      </ModuleGuard>,
    );

    expect(screen.getByTestId('real-screen')).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'Projects is hidden' })).toBeNull();
    expect(screen.queryByTestId('module-guard-show')).toBeNull();
  });
});

describe('route wiring — only optional pages are guarded', () => {
  const routesDir = resolve(dirname(fileURLToPath(import.meta.url)), '../../routes');
  const routeSource = (file: string) => readFileSync(resolve(routesDir, file), 'utf8');

  const guarded = [
    'projects',
    'purchase-orders',
    'contacts',
    'bookings',
    'upcoming',
    'activity',
    'reports',
    'alerts',
    'sync',
    'home-assistant',
  ];
  const unguarded = ['index', 'inventory', 'settings', 'about', 'deep-link', 'share-target', 'import'];

  it.each(guarded)('wraps the %s route in ModuleGuard', (route) => {
    expect(routeSource(`${route}.tsx`)).toContain('ModuleGuard');
  });

  it.each(unguarded)('never guards the %s route', (route) => {
    expect(routeSource(`${route}.tsx`)).not.toContain('ModuleGuard');
  });
});

/**
 * Issue #429. This interstitial is a *second* door onto the module list — the Modules screen is
 * not the only way to switch a feature back on — so an ungated **Show this module** would have
 * left the whole `modules:write` gate decorative for anyone who could reach a hidden page.
 */
describe('ModuleGuard — module write permission', () => {
  function renderHidden() {
    useModulesStore.setState({ intent: { projects: false } });
    render(
      <ModuleGuard feature="projects">
        <Screen />
      </ModuleGuard>,
    );
  }

  it('withholds Show this module from a role that may not write the module list', () => {
    useSessionStore.setState({ authority: { mode: 'granted', grants: new Set(['modules:read']) } });
    renderHidden();

    expect(screen.queryByTestId('module-guard-show')).toBeNull();
    // Continue anyway stays: it changes nothing, and it is the only way this role sees the screen.
    expect(screen.getByTestId('module-guard-continue')).toBeTruthy();
  });

  it('keeps Show this module for a role that holds the write', () => {
    useSessionStore.setState({ authority: { mode: 'granted', grants: new Set(['modules:write']) } });
    renderHidden();

    fireEvent.click(screen.getByTestId('module-guard-show'));
    expect(useModulesStore.getState().intent.projects).toBe(true);
  });

  it('drops the shortcut into the manager for a role that cannot open it', () => {
    // Without `modules:read` the footer link would land on the refusal page, so it is not offered.
    useSessionStore.setState({ authority: { mode: 'granted', grants: new Set(['items:read']) } });
    renderHidden();

    expect(screen.queryByRole('link', { name: /manage modules/i })).toBeNull();
  });

  it('keeps the shortcut for a role that can open the manager', () => {
    useSessionStore.setState({ authority: { mode: 'granted', grants: new Set(['modules:read']) } });
    renderHidden();

    expect(screen.getByRole('link', { name: /manage modules/i }).getAttribute('href')).toBe('/modules');
  });
});
