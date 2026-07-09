/**
 * Appearance registry — the single source of truth for the two orthogonal appearance axes
 * (spec §2.1 theme; §3 dark-first aesthetic).
 *
 * Appearance is decomposed into independent choices so a colour works in either mode:
 * - **Mode** ({@link Mode}) — `light` / `dark` / `system`. Drives the neutral surfaces, the
 *   `.dark` class and `color-scheme`. `system` follows the OS `prefers-color-scheme`.
 * - **Accent** ({@link Accent}) — the brand colour (buttons, links, focus rings, the
 *   attention highlight), authored once for light and once for dark. Accent-only: it recolours
 *   `--primary`/`--ring`/`--highlight`, not the neutral surfaces, so every accent reads the
 *   same in both modes.
 *
 * Two further switches compose on top and live in the store as booleans (not here, since they
 * are not palettes): **pure-black (OLED)** — engages in dark mode to drop the surfaces to true
 * black; and **high contrast** — an accessibility mode that boosts contrast and borders over
 * whichever mode/accent is active. The apply seam (`theme.ts`) projects all four onto `<html>`
 * as the `.dark` class + `data-accent` / `data-oled` / `data-contrast` attributes; the CSS
 * blocks that back the accents/OLED/high-contrast live in `styles/index.css`, keyed to match.
 */

/** Light / dark mode, plus the `system` meta-choice (follow the OS, resolved at apply time). */
export type Mode = 'light' | 'dark' | 'system';

/** Mode choices for the Settings control, in display order. */
export const MODE_OPTIONS = [
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
  { value: 'system', label: 'System' },
] as const satisfies readonly { value: Mode; label: string }[];

/** The default mode when nothing is persisted (the app's dark-first aesthetic, §3). */
export const DEFAULT_MODE: Mode = 'dark';

/** Coerce an arbitrary (stale/unknown) persisted value to a valid {@link Mode} (default dark). */
export function normaliseMode(value: string): Mode {
  return (MODE_OPTIONS as readonly { value: string }[]).some((o) => o.value === value)
    ? (value as Mode)
    : DEFAULT_MODE;
}

/**
 * Selectable accent colours — 14 hues spanning the full spectrum in ~26° steps, listed in
 * rainbow (hue) order so the swatch row reads as a spectrum. Each id maps to a
 * `[data-accent='<id>']` block in `styles/index.css` (light + dark variants). `violet` is the
 * app's signature default (anchored at hue 277°) and mirrors the base `--primary` so the shipped
 * look is unchanged when it is selected; the other 13 are evenly distributed around it.
 */
export const ACCENTS = [
  { id: 'rose', label: 'Rose' },
  { id: 'orange', label: 'Orange' },
  { id: 'amber', label: 'Amber' },
  { id: 'yellow', label: 'Yellow' },
  { id: 'lime', label: 'Lime' },
  { id: 'green', label: 'Green' },
  { id: 'emerald', label: 'Emerald' },
  { id: 'teal', label: 'Teal' },
  { id: 'cyan', label: 'Cyan' },
  { id: 'blue', label: 'Blue' },
  { id: 'violet', label: 'Violet' },
  { id: 'purple', label: 'Purple' },
  { id: 'fuchsia', label: 'Fuchsia' },
  { id: 'pink', label: 'Pink' },
] as const;

/** An accent colour id. */
export type Accent = (typeof ACCENTS)[number]['id'];

/** Every accent id, for iteration / validation. */
export const ACCENT_IDS = ACCENTS.map((a) => a.id) as Accent[];

/** The default accent — the app's signature violet. */
export const DEFAULT_ACCENT: Accent = 'violet';

/** Coerce an arbitrary (stale/unknown) persisted value to a valid {@link Accent} (default violet). */
export function normaliseAccent(value: string): Accent {
  return (ACCENT_IDS as readonly string[]).includes(value) ? (value as Accent) : DEFAULT_ACCENT;
}
