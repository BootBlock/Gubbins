import { describe, it, expect } from 'vitest';
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
