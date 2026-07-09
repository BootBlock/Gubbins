/**
 * Theme registry — the single source of truth for every selectable full colour theme
 * (spec §2.1 theme; §3 dark-first aesthetic).
 *
 * Each entry is a complete named palette declared once here; adding a new theme is a small,
 * additive change — one entry plus a matching `:root[data-theme='<id>']` token block in
 * `styles/index.css`. Everything downstream derives from {@link THEMES}: the picker options
 * ({@link settings.THEME_OPTIONS}), the store's {@link Theme} type, the apply seam's
 * base lookup ({@link theme.applyTheme}) and the Settings toggle's icons/tooltips.
 *
 * Every theme declares a `base` (`'light' | 'dark'`): the apply seam still toggles the `.dark`
 * class for any dark-base theme, so the existing `@custom-variant dark`, the handful of `dark:`
 * utilities, `color-scheme` and the reduced-motion catch-all keep working unchanged while the
 * `data-theme` attribute selects the concrete palette. `'system'` is a separate, non-palette
 * meta-choice handled in the store/apply seam (it resolves to the light or dark *base* per the
 * OS `prefers-color-scheme`), so it is intentionally absent from this array.
 */
import { createElement, type ReactNode } from 'react';
import {
  ContrastThemeIcon,
  DarkThemeIcon,
  LightThemeIcon,
  MidnightThemeIcon,
  SepiaThemeIcon,
} from '@/components/icons';

/** Whether a theme's palette is fundamentally light or dark (drives the `.dark` class + `color-scheme`). */
export type ThemeBase = 'light' | 'dark';

export interface ThemeDef {
  /** Stable id — the persisted preference value and the `data-theme` attribute value. */
  readonly id: string;
  /** Human label shown in the Settings picker. */
  readonly label: string;
  /** Light or dark base — the apply seam toggles `.dark` for a dark base. */
  readonly base: ThemeBase;
  /** What the theme does, surfaced on hover in the Settings picker. */
  readonly tooltip: string;
  /** Decorative glyph for the picker (aria-hidden; the button's label carries the name). */
  readonly icon: ReactNode;
}

/**
 * Every selectable full theme. `dark` / `light` are the two originals (their palettes live in
 * the `.dark` / `:root` blocks); the rest are the additive named themes. Order is the picker's
 * display order.
 */
export const THEMES = [
  {
    id: 'dark',
    label: 'Dark',
    base: 'dark',
    tooltip: 'Always use the deep dark palette.',
    icon: createElement(DarkThemeIcon),
  },
  {
    id: 'light',
    label: 'Light',
    base: 'light',
    tooltip: 'Always use the light palette.',
    icon: createElement(LightThemeIcon),
  },
  {
    id: 'midnight',
    label: 'Midnight',
    base: 'dark',
    tooltip: 'A deep navy-blue dark palette with cool azure accents.',
    icon: createElement(MidnightThemeIcon),
  },
  {
    id: 'sepia',
    label: 'Sepia',
    base: 'light',
    tooltip: 'A warm, paper-like light palette that’s easy on the eyes.',
    icon: createElement(SepiaThemeIcon),
  },
  {
    id: 'high-contrast',
    label: 'High contrast',
    base: 'dark',
    tooltip: 'Maximum contrast — pure black, white text and bold borders.',
    icon: createElement(ContrastThemeIcon),
  },
] as const satisfies readonly ThemeDef[];

/** The id of a concrete theme (excludes the `'system'` meta-choice). */
export type ThemeId = (typeof THEMES)[number]['id'];

/**
 * The persisted theme preference: a concrete {@link ThemeId} or `'system'` (follow the OS,
 * resolving to the light/dark *base* palette at apply time). Re-exported from
 * `usePreferencesStore` so existing importers keep working.
 */
export type Theme = ThemeId | 'system';

/** Every concrete theme id (no `'system'`), for iteration / validation. */
export const THEME_IDS = THEMES.map((t) => t.id) as ThemeId[];

/** Lookup: concrete theme id → its `base`. Drives the `.dark` toggle in the apply seam. */
export const THEME_BASE = Object.fromEntries(THEMES.map((t) => [t.id, t.base])) as Record<ThemeId, ThemeBase>;

/** The canonical light-base and dark-base ids the `'system'` choice resolves to. */
export const SYSTEM_LIGHT_ID: ThemeId = 'light';
export const SYSTEM_DARK_ID: ThemeId = 'dark';

/** The default theme when nothing is persisted (the app's dark-first aesthetic, §3). */
export const DEFAULT_THEME: Theme = 'dark';

/**
 * Coerce an arbitrary (possibly stale/unknown) persisted value to a valid {@link Theme},
 * falling back to {@link DEFAULT_THEME}. Kept total so a value from an older/newer build can
 * never reach the apply seam as an unknown id.
 */
export function normaliseTheme(value: string): Theme {
  if (value === 'system') return 'system';
  return (THEME_IDS as readonly string[]).includes(value) ? (value as ThemeId) : DEFAULT_THEME;
}
