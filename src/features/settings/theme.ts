/**
 * Theme application (spec §2.1 theme; §3 premium dark-first aesthetic).
 *
 * The design system in `styles/index.css` is class-based for the two originals (`:root` is the
 * light palette, a `.dark` ancestor switches to dark) and attribute-based for every additional
 * named theme (`:root[data-theme='<id>']`). `usePreferencesStore` holds the chosen theme; this
 * is the single seam that projects that value onto the document. It sets `data-theme` to the
 * resolved concrete theme id AND toggles the `.dark` class for any theme whose {@link ThemeBase}
 * is dark — so `@custom-variant dark`, the `dark:` utilities, `color-scheme` and the
 * reduced-motion catch-all all keep working unchanged. The `'system'` choice is resolved against
 * the OS `prefers-color-scheme` here (to the light/dark *base* id). `resolveTheme` is pure (the
 * OS preference is injected) so it is unit-testable without a `matchMedia` mock. The theme
 * registry (`theme-registry.ts`) is the SSOT for the id → base mapping.
 */
import { SYSTEM_DARK_ID, SYSTEM_LIGHT_ID, THEME_BASE, type Theme, type ThemeId } from './theme-registry';

/** The CSS class the palette toggles for a dark-base theme (see styles/index.css). */
export const DARK_CLASS = 'dark';

/** The media query backing the `'system'` theme. */
export const PREFERS_DARK_QUERY = '(prefers-color-scheme: dark)';

/**
 * Resolve a (possibly `'system'`) theme to a concrete theme id. For `'system'` the caller
 * supplies whether the OS currently prefers dark, resolving to the dark/light *base* id; an
 * explicit theme is returned unchanged.
 */
export function resolveTheme(theme: Theme, prefersDark: boolean): ThemeId {
  if (theme === 'system') return prefersDark ? SYSTEM_DARK_ID : SYSTEM_LIGHT_ID;
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

/**
 * Apply `theme` to `root` (idempotent). Sets `data-theme` to the resolved concrete id and
 * toggles the `.dark` class to match that theme's base. `:root` is light's canonical block, so
 * plain light *clears* the attribute; every other theme is keyed by `[data-theme='<id>']`.
 */
export function applyTheme(theme: Theme, root: HTMLElement = document.documentElement): void {
  const id = resolveTheme(theme, systemPrefersDark());
  const base = THEME_BASE[id] ?? 'dark';
  if (id === SYSTEM_LIGHT_ID) delete root.dataset.theme;
  else root.dataset.theme = id;
  root.classList.toggle(DARK_CLASS, base === 'dark');
}
