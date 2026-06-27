import { createRouter } from '@tanstack/react-router';
import { routeTree } from '@/routeTree.gen';

/**
 * The type-safe client-side router (spec §2.4.2). `routeTree` is generated from
 * src/routes by the TanStack Router Vite plugin.
 *
 * The router must share Vite's base path (spec §1.2: `/Gubbins/`) so routes match
 * when the app is served under that sub-path — both on the dev server and on
 * GitHub Pages. We derive it from BASE_URL (trailing slash trimmed) and fall back
 * to root when deployed at '/'.
 */
/** Derive the router basepath from Vite's BASE_URL (trailing slash trimmed; root → undefined). */
export function resolveBasepath(baseUrl: string): string | undefined {
  return baseUrl === '/' ? undefined : baseUrl.replace(/\/+$/, '');
}

const basepath = resolveBasepath(import.meta.env.BASE_URL);

export const router = createRouter({
  routeTree,
  basepath,
  defaultPreload: 'intent',
  scrollRestoration: true,
});

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}
