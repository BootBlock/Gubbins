/**
 * Appearance application (spec §2.1 theme; §3 premium dark-first aesthetic).
 *
 * The two orthogonal axes (mode + accent) and the two composable switches (OLED, high contrast)
 * live in `usePreferencesStore`; this is the single seam that projects them onto the document.
 * It toggles the `.dark` class for the resolved mode (so `@custom-variant dark`, the `dark:`
 * utilities, `color-scheme` and the reduced-motion catch-all keep working) and sets four data
 * attributes the CSS palettes / motion catch-all key off: `data-accent` (the colour),
 * `data-oled` (pure-black surfaces, effective only in dark mode), `data-contrast="high"` (the
 * accessibility mode) and `data-reduce-effects` (the visual-flair F9 "Reduce effects" switch —
 * dials the decorative motion/flair down independently of the OS reduced-motion setting).
 * The `system` mode is resolved against the OS `prefers-color-scheme` here. `resolveMode` is
 * pure (the OS preference is injected) so it is unit-testable without a `matchMedia` mock. The
 * appearance registry (`theme-registry.ts`) is the SSOT for the mode/accent ids.
 */
import {
  customAccentVars,
  suppressesMotion,
  type Accent,
  type AnimationLevel,
  type Mode,
  type SurfaceStyle,
} from './theme-registry';

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
  /**
   * Animation level: how visually animated the interface is (`full` → `headache`). Supersedes the
   * binary "Reduce effects" switch. Projected as `data-anim-level` (for the graded static-flair
   * opt-outs) plus `data-reduce-effects` for the motion-off tiers (Calm and calmer), so the whole
   * F9 CSS + JS gate machinery keeps working unchanged. Additive to OS `prefers-reduced-motion`.
   */
  readonly animationLevel: AnimationLevel;
  /**
   * Holographic-foil item cards (Appearance flair): projected as the presence-only
   * `data-holo-cards` attribute (on = present). The CSS gates the foil to the maximal
   * `headache` tier + a fine pointer + full motion, so the attribute alone never forces it on.
   */
  readonly holographicCards: boolean;
  /**
   * Collector-card rarity gamification (Appearance flair): projected as the presence-only
   * `data-gamify-cards` attribute (on = present). The CSS shows the rarity frame/badge only at
   * the maximal `headache` tier, so the attribute alone never forces it on at a calmer level.
   */
  readonly gamifyCards: boolean;
  /**
   * Branding — a **custom accent hue** that overrides the preset {@link Accent} when enabled. When
   * `enabled`, the seam projects the four brand tokens ({@link customAccentVars}) as inline custom
   * properties on `<html>` for the resolved mode, so they win over the `[data-accent]` stylesheet
   * block; when off, the inline properties are cleared and the preset accent resumes. The `hue` is a
   * 0–359° angle.
   */
  readonly customAccent: { readonly enabled: boolean; readonly hue: number };
  /**
   * Branding — the **surface style** ({@link SurfaceStyle}): how opaque the app's content surfaces
   * are. Projected as `data-surface="<id>"` (the `solid` default carries no attribute), which the
   * `[data-surface]` CSS blocks read to re-mix the card tokens. Overlays stay opaque; high contrast
   * forces solid regardless.
   */
  readonly surfaceStyle: SurfaceStyle;
}

/** The four brand-accent custom properties the seam sets/clears for a custom hue. */
const CUSTOM_ACCENT_PROPS = ['--primary', '--primary-foreground', '--ring', '--highlight'] as const;

/**
 * Apply `appearance` to `root` (idempotent): toggle `.dark` for the resolved mode, set
 * `data-accent`, and set/clear `data-oled` / `data-contrast` / `data-reduce-effects` /
 * `data-holo-cards` / `data-gamify-cards` for the composable switches.
 */
export function applyAppearance(appearance: Appearance, root: HTMLElement = document.documentElement): void {
  const base = resolveMode(appearance.mode, systemPrefersDark());
  root.classList.toggle(DARK_CLASS, base === 'dark');
  root.dataset.accent = appearance.accent;
  if (appearance.oledDark) root.dataset.oled = '';
  else delete root.dataset.oled;
  if (appearance.highContrast) root.dataset.contrast = 'high';
  else delete root.dataset.contrast;
  // Animation level: the `headache` "everything on" default carries no attribute; calmer levels set
  // `data-anim-level` for the graded static-flair opt-outs (spotlight off at Balanced; starfield/
  // glow off at Minimal; tints off at Off). The motion-off tiers (Calm and calmer) additionally set
  // the `data-reduce-effects` flag, whose `styles/index.css` catch-all mirror clamps every
  // decorative transition/animation — so one derived flag drives the whole motion-suppression layer.
  if (appearance.animationLevel !== 'headache') root.dataset.animLevel = appearance.animationLevel;
  else delete root.dataset.animLevel;
  if (suppressesMotion(appearance.animationLevel)) root.dataset.reduceEffects = '';
  else delete root.dataset.reduceEffects;
  // Appearance flair: presence-only flags for the holographic foil + collector-card gamification.
  // The CSS scopes both to the maximal `headache` tier (and the foil to a fine pointer + full
  // motion), so setting the attribute is necessary but not sufficient — a calmer level shows neither.
  if (appearance.holographicCards) root.dataset.holoCards = '';
  else delete root.dataset.holoCards;
  if (appearance.gamifyCards) root.dataset.gamifyCards = '';
  else delete root.dataset.gamifyCards;
  // Branding — surface style: the `solid` default carries no attribute (baseline unchanged); the
  // translucent styles set `data-surface`, which the styles/index.css blocks read to re-mix `--card`.
  if (appearance.surfaceStyle !== 'solid') root.dataset.surface = appearance.surfaceStyle;
  else delete root.dataset.surface;
  // Branding — custom accent hue: when enabled, set the four brand tokens inline for the *resolved*
  // mode (light/dark tuned), overriding the [data-accent] block; when off, clear them so the preset
  // accent resumes. Setting them inline (rather than a stylesheet block) keeps the hue fully dynamic.
  if (appearance.customAccent.enabled) {
    const vars = customAccentVars(appearance.customAccent.hue, base === 'dark');
    for (const prop of CUSTOM_ACCENT_PROPS) root.style.setProperty(prop, vars[prop]);
  } else {
    for (const prop of CUSTOM_ACCENT_PROPS) root.style.removeProperty(prop);
  }
}
