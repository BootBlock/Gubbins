import { createRouter } from '@tanstack/react-router';
import { routeTree } from '@/routeTree.gen';
import { resolveRouteViewTransitionTypes } from '@/components/foundry/view-transition';
import { NotFoundScreen } from '@/features/not-found/NotFoundScreen';
import { RouteErrorScreen } from '@/features/not-found/RouteErrorScreen';

/**
 * The type-safe client-side router (spec §2.4.2). `routeTree` is generated from
 * src/routes by the TanStack Router Vite plugin.
 *
 * The router must share Vite's base path (spec §1.2: `/Gubbins/`) so routes match
 * when the app is served under that sub-path — both on the dev server and on
 * GitHub Pages. We derive it from BASE_URL (trailing slash trimmed) and fall back
 * to root when deployed at '/'.
 */
/**
 * Derive the router basepath from Vite's BASE_URL (trailing slash trimmed; root → undefined).
 *
 * @internal Exported for unit tests only.
 */
export function resolveBasepath(baseUrl: string): string | undefined {
  return baseUrl === '/' ? undefined : baseUrl.replace(/\/+$/, '');
}

const basepath = resolveBasepath(import.meta.env.BASE_URL);

export const router = createRouter({
  routeTree,
  basepath,
  defaultPreload: 'intent',
  scrollRestoration: true,
  // Cross-fade every top-level screen navigation via the View Transitions API (visual-flair
  // F6). The gate lives in one place: `resolveRouteViewTransitionTypes` returns `false` — so
  // TanStack Router runs the navigation directly, with no `startViewTransition` — where the
  // API is unavailable or the user prefers reduced motion, and only cross-fades on an actual
  // pathname change (not an in-screen search/hash update). The cross-fade itself is styled on
  // the `::view-transition-*` pseudo-elements in `styles/index.css`.
  defaultViewTransition: { types: resolveRouteViewTransitionTypes },
  // A URL that resolves to no route renders the styled 404 screen (issue #41) inside the normal
  // app chrome, with fuzzy "did you mean…?" suggestions, rather than the router's bare fallback.
  defaultNotFoundComponent: NotFoundScreen,
  // An error thrown while a route loads renders the matching styled error screen. The top-level
  // Safe Mode boundary still backstops a total render collapse; this handles the recoverable case.
  defaultErrorComponent: RouteErrorScreen,
});

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}
