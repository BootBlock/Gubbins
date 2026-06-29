/**
 * Theme application (spec §2.1 theme; §3 premium dark-first aesthetic).
 *
 * The design system in `styles/index.css` is class-based: `:root` is the light
 * palette and a `.dark` ancestor switches to the dark palette. `usePreferencesStore`
 * holds the chosen theme; this is the single seam that actually projects that value
 * onto the document. The `'system'` choice is resolved against the OS
 * `prefers-color-scheme` here. `resolveTheme` is pure (the OS preference is injected)
 * so it is unit-testable without a `matchMedia` mock.
 */
import type { Theme } from '@/state/stores/usePreferencesStore';

/** The CSS class the palette toggles for dark mode (see styles/index.css). */
export const DARK_CLASS = 'dark';

/** The media query backing the `'system'` theme. */
export const PREFERS_DARK_QUERY = '(prefers-color-scheme: dark)';

/**
 * Resolve a (possibly `'system'`) theme to the concrete palette. For `'system'` the
 * caller supplies whether the OS currently prefers dark; an explicit theme ignores it.
 */
export function resolveTheme(theme: Theme, prefersDark: boolean): 'dark' | 'light' {
  if (theme === 'system') return prefersDark ? 'dark' : 'light';
  return theme;
}

/**
 * Whether the OS currently prefers a dark colour scheme. Feature-detected; defaults
 * to the app's dark-first aesthetic (§3) where `matchMedia` is unavailable.
 */
export function systemPrefersDark(): boolean {
  if (typeof matchMedia !== 'function') return true;
  return matchMedia(PREFERS_DARK_QUERY).matches;
}

/** Apply `theme` to `root` by toggling the `.dark` class (idempotent). */
export function applyTheme(theme: Theme, root: HTMLElement = document.documentElement): void {
  root.classList.toggle(DARK_CLASS, resolveTheme(theme, systemPrefersDark()) === 'dark');
}
