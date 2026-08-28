import { describe, it, expect, afterEach, vi } from 'vitest';
import { createMemoryHistory, createRouter } from '@tanstack/react-router';
import { routeTree } from '@/routeTree.gen';
import {
  resolveRouteViewTransitionTypes,
  viewTransitionTypesSupported,
} from '@/components/foundry/view-transition';
import { resolveBasepath, resolveDefaultViewTransition, router } from './router';

describe('resolveBasepath', () => {
  it('trims the trailing slash from a sub-path base', () => {
    expect(resolveBasepath('/Gubbins/')).toBe('/Gubbins');
    expect(resolveBasepath('/foo/bar/')).toBe('/foo/bar');
  });

  it('returns undefined for a root ("/") deployment', () => {
    expect(resolveBasepath('/')).toBeUndefined();
  });
});

describe('router basepath matching', () => {
  it('matches the index route when the app is served under /Gubbins/', async () => {
    const router = createRouter({
      routeTree,
      basepath: '/Gubbins',
      history: createMemoryHistory({ initialEntries: ['/Gubbins/'] }),
    });

    await router.load();

    const routeIds = router.state.matches.map((match) => match.routeId);
    // Regression guard: without a basepath, '/Gubbins/' would fall through to
    // Not Found instead of resolving the index route ('/').
    expect(routeIds).toContain('/');
  });
});

describe('resolveDefaultViewTransition', () => {
  it('configures the gated form where the router would consult the gate', () => {
    expect(resolveDefaultViewTransition(true)).toEqual({ types: resolveRouteViewTransitionTypes });
  });

  it('turns route transitions off where it would not', () => {
    // The object form is not "transition, gated" on such a browser — TanStack Router skips the
    // `types` resolver and cross-fades the whole document on every location change, same-path
    // ones included. Since an open dialog is now a history entry (issue #590), that would fire
    // on every dialog opened and every Back that dismisses one.
    expect(resolveDefaultViewTransition(false)).toBe(false);
  });

  it('is what the live router is configured with', () => {
    expect(router.options.defaultViewTransition).toEqual(
      resolveDefaultViewTransition(viewTransitionTypesSupported()),
    );
  });
});

describe('what actually decides whether the router consults the view-transition gate', () => {
  const realSupports = window.CSS?.supports;

  afterEach(() => {
    if (window.CSS) window.CSS.supports = realSupports as typeof window.CSS.supports;
    delete (document as { startViewTransition?: unknown }).startViewTransition;
  });

  /**
   * The drift test named by `viewTransitionTypesSupported`. Its docstring, and the choice
   * `resolveDefaultViewTransition` makes on the strength of it, both rest on a condition that
   * lives inside `@tanstack/router-core` and is not part of its API. So this drives the *real*
   * router rather than restating our copy of the condition: if a future version starts
   * consulting the `types` resolver without the selector — or stops consulting it with one —
   * this fails, and the choice needs revisiting.
   */
  const driveRouter = (selectorSupported: boolean) => {
    window.CSS = {
      ...(window.CSS ?? {}),
      supports: vi.fn(() => selectorSupported),
    } as unknown as typeof window.CSS;
    (document as { startViewTransition?: unknown }).startViewTransition = (
      arg: (() => void) | { update: () => void },
    ) => ({ updateCallbackDone: Promise.resolve((typeof arg === 'function' ? arg : arg.update)()) });

    const types = vi.fn(() => false as const);
    const router = createRouter({
      routeTree,
      history: createMemoryHistory({ initialEntries: ['/'] }),
      defaultViewTransition: { types },
    });
    router.startViewTransition(() => {});
    return types;
  };

  it('skips the resolver where the view-transition-type selector is unsupported', () => {
    // Which is why `resolveDefaultViewTransition(false)` turns transitions off outright: the
    // object form there would cross-fade the whole document with nothing gating it.
    expect(driveRouter(false)).not.toHaveBeenCalled();
  });

  it('consults the resolver where it is supported', () => {
    expect(driveRouter(true)).toHaveBeenCalled();
  });
});
