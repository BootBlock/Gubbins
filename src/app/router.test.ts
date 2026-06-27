import { describe, it, expect } from 'vitest';
import { createMemoryHistory, createRouter } from '@tanstack/react-router';
import { routeTree } from '@/routeTree.gen';
import { resolveBasepath } from './router';

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
