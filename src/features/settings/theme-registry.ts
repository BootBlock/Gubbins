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

/**
 * Starfield variant (visual-flair F11) — a purely decorative recolour of the About-screen
 * starfield ({@link import('../about/Starfield').Starfield}). Layered on the one existing
 * themeable starfield: each variant only re-points the `--star` / `--star-flare` tokens in
 * `styles/index.css` (keyed to `data-starfield="<id>"` on `<html>`), never a second field.
 *
 * - `cosmic` — the shipped violet/cyan look (default; nothing regresses).
 * - `accent` — tracks the Colour axis: the flare is derived from the active `--highlight`
 *   accent token via `color-mix`, so it recolours with whatever accent is chosen.
 * - `aurora` — a cool green→teal mood preset.
 * - `ember` — a warm amber→rose mood preset.
 * - `mono` — an understated neutral sky (no coloured flare).
 */
export const STARFIELD_VARIANTS = [
  { id: 'cosmic', label: 'Cosmic' },
  { id: 'accent', label: 'Accent' },
  { id: 'aurora', label: 'Aurora' },
  { id: 'ember', label: 'Ember' },
  { id: 'mono', label: 'Mono' },
] as const;

/** A starfield variant id. */
export type StarfieldVariant = (typeof STARFIELD_VARIANTS)[number]['id'];

/** Every starfield variant id, for iteration / validation. */
export const STARFIELD_VARIANT_IDS = STARFIELD_VARIANTS.map((v) => v.id) as StarfieldVariant[];

/** The default starfield variant — the shipped cosmic look, so the baseline is unchanged. */
export const DEFAULT_STARFIELD_VARIANT: StarfieldVariant = 'cosmic';

/** Coerce an arbitrary (stale/unknown) persisted value to a valid {@link StarfieldVariant}. */
export function normaliseStarfieldVariant(value: string): StarfieldVariant {
  return (STARFIELD_VARIANT_IDS as readonly string[]).includes(value)
    ? (value as StarfieldVariant)
    : DEFAULT_STARFIELD_VARIANT;
}

/**
 * Animation level — how visually animated the interface is (visual-flair; offered up-front on the
 * first-run wizard and in Settings → Appearance). A single graded scale that supersedes the earlier
 * binary "Reduce effects" switch, listed **liveliest → calmest** so its array index is its rank.
 *
 * The rank drives two thresholds, encoded once here ({@link suppressesFlourish} /
 * {@link suppressesMotion}) so every effect reads the tier meaning from the SSOT rather than
 * hard-coding a level id:
 * - `full` — everything on (default; nothing suppressed).
 * - `balanced` — the showiest **flourishes** off (success bursts, card tilt/parallax, the spotlight
 *   sweep); the gentler motion stays.
 * - `calm` — all decorative **motion** holds still (number roll-ups, scroll reveals, page
 *   cross-fades, badge/toast/ring pops), i.e. the former "Reduce effects" behaviour; static flair
 *   (accent glow, per-location tint, the still starfield) remains.
 * - `off` — Calm, plus the ambient decorations themselves drop: the drifting starfield and the
 *   accent glow are switched off.
 * - `headache` — Off, plus the remaining decorative colour (per-location tints, decorative
 *   gradients) is dialled back for the calmest, most uniform interface.
 *
 * This is *additive to* the OS `prefers-reduced-motion` setting, never subtractive — see
 * `components/foundry/decoration-motion.ts`.
 */
export const ANIMATION_LEVELS = [
  {
    id: 'full',
    label: 'Full',
    description: 'Every animation and flourish, just as designed.',
  },
  {
    id: 'balanced',
    label: 'Balanced',
    description:
      'Keeps the gentle motion but drops the showiest flourishes — success bursts, card tilt and the spotlight sweep.',
  },
  {
    id: 'calm',
    label: 'Calm',
    description:
      'All decorative motion holds still — number roll-ups, reveals, page cross-fades and pops settle instantly.',
  },
  {
    id: 'off',
    label: 'Off',
    description:
      'No decorative motion, and the ambient touches — the drifting starfield and accent glow — switch off too.',
  },
  {
    id: 'headache',
    label: 'I have a headache',
    description:
      'For when the app’s cheerful little flourishes feel like a marching band inside your skull. Everything holds perfectly still, the stars stop drifting and the decorative colour is dialled right back — the calmest, quietest Gubbins can be. Turn it back up once the paracetamol kicks in.',
  },
] as const;

/** An animation level id. */
export type AnimationLevel = (typeof ANIMATION_LEVELS)[number]['id'];

/** Every animation level id, liveliest → calmest (index === rank), for iteration / validation. */
export const ANIMATION_LEVEL_IDS = ANIMATION_LEVELS.map((l) => l.id) as AnimationLevel[];

/** The default animation level — everything on, so the shipped experience is unchanged. */
export const DEFAULT_ANIMATION_LEVEL: AnimationLevel = 'full';

/** Coerce an arbitrary (stale/unknown) persisted value to a valid {@link AnimationLevel}. */
export function normaliseAnimationLevel(value: string): AnimationLevel {
  return (ANIMATION_LEVEL_IDS as readonly string[]).includes(value)
    ? (value as AnimationLevel)
    : DEFAULT_ANIMATION_LEVEL;
}

/** A level's rank on the liveliest(0) → calmest scale. Higher = calmer / more suppressed. */
export function animationLevelRank(level: AnimationLevel): number {
  return ANIMATION_LEVEL_IDS.indexOf(level);
}

/**
 * Whether the loud "flourish" effects (success bursts, pointer tilt/parallax, the spotlight sweep)
 * are suppressed at this level — i.e. Balanced and calmer. The single source for that threshold.
 */
export function suppressesFlourish(level: AnimationLevel): boolean {
  return animationLevelRank(level) >= animationLevelRank('balanced');
}

/**
 * Whether *all* decorative motion is suppressed at this level — i.e. Calm and calmer. Mirrors the
 * former binary "Reduce effects" behaviour; the apply seam projects `data-reduce-effects` off this.
 */
export function suppressesMotion(level: AnimationLevel): boolean {
  return animationLevelRank(level) >= animationLevelRank('calm');
}
