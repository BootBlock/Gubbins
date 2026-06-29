/**
 * Reduced-motion preference detection (spec §3 premium-but-accessible UI; WCAG 2.3.3
 * Animation from Interactions / vestibular safety).
 *
 * Gubbins is deliberately animation-rich (§3 "fluid CSS transitions", "colour pulsing
 * on success states", "smooth expand/collapse animations"). A user who has asked their
 * OS to minimise non-essential motion must have that honoured. The CSS `@media
 * (prefers-reduced-motion: reduce)` block in `styles/index.css` is the global catch-all;
 * this tiny module is the matching JS seam (mirroring `theme.ts`'s `systemPrefersDark`)
 * so the Foundry primitives can also respect the preference at source.
 *
 * `prefersReducedMotion` is feature-detected and falls back to `false` (full motion)
 * where `matchMedia` is unavailable — in that case the CSS media query remains the
 * authority, so nothing is lost.
 */

/** The media query backing the reduced-motion preference. */
export const PREFERS_REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)';

/**
 * Whether the user currently prefers reduced motion. Feature-detected; defaults to
 * `false` (motion permitted) where `matchMedia` is unavailable.
 */
export function prefersReducedMotion(): boolean {
  if (typeof matchMedia !== 'function') return false;
  return matchMedia(PREFERS_REDUCED_MOTION_QUERY).matches;
}
