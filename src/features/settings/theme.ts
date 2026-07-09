/**
 * Appearance application (spec §2.1 theme; §3 premium dark-first aesthetic).
 *
 * The two orthogonal axes (mode + accent) and the two composable switches (OLED, high contrast)
 * live in `usePreferencesStore`; this is the single seam that projects them onto the document.
 * It toggles the `.dark` class for the resolved mode (so `@custom-variant dark`, the `dark:`
 * utilities, `color-scheme` and the reduced-motion catch-all keep working) and sets three data
 * attributes the CSS palettes key off: `data-accent` (the colour), `data-oled` (pure-black
 * surfaces, effective only in dark mode) and `data-contrast="high"` (the accessibility mode).
 * The `system` mode is resolved against the OS `prefers-color-scheme` here. `resolveMode` is
 * pure (the OS preference is injected) so it is unit-testable without a `matchMedia` mock. The
 * appearance registry (`theme-registry.ts`) is the SSOT for the mode/accent ids.
 */
import type { Accent, Mode } from './theme-registry';

/** The CSS class the palette toggles for dark mode (see styles/index.css). */
export const DARK_CLASS = 'dark';

/** The media query backing the `system` mode. */
export const PREFERS_DARK_QUERY = '(prefers-color-scheme: dark)';

/**
 * Resolve a (possibly `system`) mode to a concrete `light`/`dark`. For `system` the caller
 * supplies whether the OS currently prefers dark; an explicit mode ignores it.
 */
export function resolveMode(mode: Mode, prefersDark: boolean): 'light' | 'dark' {
  if (mode === 'system') return prefersDark ? 'dark' : 'light';
  return mode;
}

/**
 * Whether the OS currently prefers a dark colour scheme. Feature-detected; defaults
 * to the app's dark-first aesthetic (§3) where `matchMedia` is unavailable.
 */
export function systemPrefersDark(): boolean {
  if (typeof matchMedia !== 'function') return true;
  return matchMedia(PREFERS_DARK_QUERY).matches;
}

/** The full appearance state the seam projects onto the document. */
export interface Appearance {
  readonly mode: Mode;
  readonly accent: Accent;
  /** Pure-black surfaces; only takes visual effect in dark mode (the CSS scopes it to `.dark`). */
  readonly oledDark: boolean;
  /** Accessibility high-contrast mode; overrides mode/accent contrast + borders. */
  readonly highContrast: boolean;
}

/**
 * Apply `appearance` to `root` (idempotent): toggle `.dark` for the resolved mode, set
 * `data-accent`, and set/clear `data-oled` / `data-contrast` for the two switches.
 */
export function applyAppearance(appearance: Appearance, root: HTMLElement = document.documentElement): void {
  const base = resolveMode(appearance.mode, systemPrefersDark());
  root.classList.toggle(DARK_CLASS, base === 'dark');
  root.dataset.accent = appearance.accent;
  if (appearance.oledDark) root.dataset.oled = '';
  else delete root.dataset.oled;
  if (appearance.highContrast) root.dataset.contrast = 'high';
  else delete root.dataset.contrast;
}
