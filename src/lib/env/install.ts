/**
 * PWA installation-state detection (spec §2 "Must support installation to Home
 * Screen/Desktop"; §2 ephemeral-data persistence safeguard).
 *
 * Installing Gubbins as a PWA is the most reliable route to *persistent* OPFS
 * storage (the browser is far less likely to evict an installed app), so the §2
 * ephemeral-data warning explicitly nudges installation. This tiny module is the
 * pure, feature-detected seam for "are we already running as an installed app?",
 * mirroring `motion.ts`'s `prefersReducedMotion` / `theme.ts`'s `systemPrefersDark`.
 * The matching live `beforeinstallprompt` capture lives in `useInstallPrompt`.
 *
 * Feature-detected throughout: returns `false` (not standalone — show the install
 * affordance) where the relevant API is unavailable, so nothing is lost.
 */

/** The media query that is true when the app runs in a standalone (installed) window. */
export const STANDALONE_DISPLAY_QUERY = '(display-mode: standalone)';

/**
 * Whether the app is currently running as an installed / standalone PWA. Checks the
 * iOS-only non-standard `navigator.standalone` flag first (Safari never exposes
 * `display-mode: standalone` via `matchMedia` the same way), then the standard
 * `display-mode` media query. Defaults to `false` where neither is available.
 */
export function isStandaloneDisplay(): boolean {
  if (typeof navigator !== 'undefined') {
    // iOS Safari signals an installed Home-Screen app via this legacy flag only.
    const iosStandalone = (navigator as Navigator & { standalone?: boolean }).standalone;
    if (iosStandalone === true) return true;
  }
  if (typeof matchMedia === 'function') {
    return matchMedia(STANDALONE_DISPLAY_QUERY).matches;
  }
  return false;
}
