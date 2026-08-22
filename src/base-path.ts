/**
 * Build-time resolution of the public path Gubbins is served from.
 *
 * This module is consumed by `vite.config.ts` and — for {@link DEFAULT_BASE_PATH} — by the
 * extension's `features/scraping/app-origins.ts`. Like `src/csp.ts` it lives under `src/` so it
 * is type-checked and unit-tested with the rest of the app, but it never enters the PWA bundle.
 *
 * GitHub Pages serves Gubbins under a project sub-path (spec §1.2), so `/Gubbins/` stays
 * the default. A self-hosted deployment (see `Dockerfile`) usually serves it at the domain
 * root instead, hence the `GUBBINS_BASE_PATH` override.
 */

/** The path GitHub Pages serves the project from (spec §1.2). */
export const DEFAULT_BASE_PATH = '/Gubbins/';

/**
 * Normalise a configured base path to the leading-and-trailing-slash form Vite requires.
 *
 * A malformed base is worth guarding rather than passing through: Vite does not validate
 * it, so `gubbins` (no slashes) builds cleanly and then 404s every asset at runtime. The
 * failure surfaces as a blank page long after the build that caused it.
 *
 * `'/'`, `''` and whitespace-only all mean "serve from the root".
 *
 * The caller passes the raw value (`vite.config.ts` reads `GUBBINS_BASE_PATH`): this module
 * sits under the app's browser tsconfig, which has no Node types, so it must not touch
 * `process` itself.
 */
export function resolveBasePath(raw: string | undefined): string {
  const trimmed = raw?.trim();
  if (trimmed === undefined || trimmed === '') return DEFAULT_BASE_PATH;

  const inner = trimmed.replace(/^\/+/, '').replace(/\/+$/, '');
  return inner === '' ? '/' : `/${inner}/`;
}
