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
 * Starfield variants — the purely decorative recolours of the About-screen starfield
 * ({@link import('../about/Starfield').Starfield}). Each is a mood preset layered on the one
 * themeable starfield: every id (except the base `cosmic`) keys a `data-starfield="<id>"` block in
 * `styles/index.css` that re-points the `--star` / `--star-flare` tokens — no new geometry/motion.
 *
 * There is **no user-facing setting** for these (issue #61): the About screen picks one at random
 * each time it opens, so the sky quietly varies without adding a preference to configure. The base
 * `cosmic` look carries no attribute (the plain `--star*` tokens).
 *
 * - `cosmic` — the signature violet/cyan look (the base; no attribute).
 * - `accent` — tracks the Colour axis: the flare is the active `--highlight` accent token (its dots
 *   mix a little of it in), so it recolours with whatever accent is chosen.
 * - `aurora` — a cool green→teal mood.
 * - `ember` — a warm amber→rose mood.
 * - `mono` — an understated neutral sky (no coloured flare).
 * - `nebula` — a magenta→purple mood.
 * - `ocean` — a deep blue→cyan mood.
 * - `sunset` — a warm orange→rose mood.
 * - `gold` — a soft champagne-gold mood.
 */
export const STARFIELD_VARIANTS = [
  'cosmic',
  'accent',
  'aurora',
  'ember',
  'mono',
  'nebula',
  'ocean',
  'sunset',
  'gold',
] as const;

/** A starfield variant id. */
export type StarfieldVariant = (typeof STARFIELD_VARIANTS)[number];

/**
 * Animation level — how visually animated the interface is (visual-flair; offered up-front on the
 * first-run wizard and in Settings → Appearance). A single graded scale that supersedes the earlier
 * binary "Reduce effects" switch, listed **most flair → least** so its array index is its rank.
 *
 * The rank drives two thresholds, encoded once here ({@link suppressesFlourish} /
 * {@link suppressesMotion}) so every effect reads the tier meaning from the SSOT rather than
 * hard-coding a level id:
 * - `headache` — **everything on** (nothing suppressed). Named for the headache all that sparkle
 *   *could* give you — it is the maximal, all-effects tier.
 * - `balanced` — **the default**: the showiest **flourishes** off (success bursts, card tilt/
 *   parallax, the spotlight sweep) while the gentler motion stays — a calm, still-lively baseline.
 * - `calm` — all decorative **motion** holds still (number roll-ups, scroll reveals, page
 *   cross-fades, badge/toast/ring pops) — matches your device's reduced-motion setting; static flair
 *   (accent glow, per-location tint, the still starfield) remains.
 * - `minimal` — Calm, plus the ambient decorations themselves drop: the drifting starfield and the
 *   accent glow are switched off.
 * - `off` — Minimal, plus the remaining decorative colour (per-location tints, decorative gradients)
 *   is dropped: **everything off**, the barest, quietest interface.
 *
 * This is *additive to* the OS `prefers-reduced-motion` setting, never subtractive — see
 * `components/foundry/decoration-motion.ts`.
 */
export const ANIMATION_LEVELS = [
  {
    id: 'headache',
    label: 'I have a headache',
    description:
      'Everything on, all at once — every animation, flourish and sparkle, plus the holographic-foil card sheen and the collector-card rarity flair, so lively it might just give you a headache. The full, maximal Gubbins.',
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
      'All decorative motion holds still — number roll-ups, reveals, page cross-fades and pops settle instantly (matches your device’s reduced-motion setting).',
  },
  {
    id: 'minimal',
    label: 'Minimal',
    description:
      'Calm, plus the ambient touches switch off too — the drifting starfield and the accent glow.',
  },
  {
    id: 'off',
    label: 'Off',
    description:
      'Everything off: no motion, no starfield or glow, and even the per-location card tints are dropped. The barest, quietest interface.',
  },
] as const;

/** An animation level id. */
export type AnimationLevel = (typeof ANIMATION_LEVELS)[number]['id'];

/** Every animation level id, most flair → least (index === rank), for iteration / validation. */
export const ANIMATION_LEVEL_IDS = ANIMATION_LEVELS.map((l) => l.id) as AnimationLevel[];

/**
 * The default animation level for a **fresh install** — `balanced`, a calm but still-lively baseline
 * that drops only the showiest flourishes. (Existing installs keep whatever they had: the store
 * migration preserves their level rather than forcing this default onto them.)
 */
export const DEFAULT_ANIMATION_LEVEL: AnimationLevel = 'balanced';

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

/**
 * Whether the app's **ambient decorations** — the drifting starfield, the accent glow, and the
 * animated background weather layer — are switched off *entirely* at this level (not merely frozen),
 * i.e. Minimal and calmer. Mirrors the `data-anim-level='minimal'|'off'` CSS that hides the
 * starfield / accent glow; the JS-driven weather layer reads it to render nothing at those tiers.
 * The third threshold on the level, alongside {@link suppressesFlourish} (Balanced+) and
 * {@link suppressesMotion} (Calm+).
 */
export function suppressesAmbient(level: AnimationLevel): boolean {
  return animationLevelRank(level) >= animationLevelRank('minimal');
}

/**
 * App-wide animated **background effect** — a purely decorative weather layer painted behind all
 * UI on every screen ({@link import('../../components/background/BackgroundEffects').BackgroundEffects}).
 * Unlike the per-screen About starfield, this is a single GPU-composited `<canvas>` mounted once at
 * the composition root; the choice drives which particle system (if any) that canvas runs.
 *
 * - `none` — no layer at all (the default; the baseline is unchanged and nothing is painted/animated).
 * - `rain` — wind-slanted falling rain streaks with depth parallax.
 * - `snow` — gently drifting, swaying snowflakes with depth parallax.
 *
 * The particle colours come from the `--precip-rain` / `--precip-snow` tokens (light + dark) in
 * `styles/index.css`. The effect is decorative (aria-hidden, pointer-events-none) and honours the
 * animation level: it animates at the livelier tiers, holds a static frame at Calm
 * ({@link suppressesMotion}), and is removed entirely at Minimal/Off ({@link suppressesAmbient}) —
 * like the starfield.
 */
export const BACKGROUND_EFFECTS = [
  { id: 'none', label: 'None' },
  { id: 'rain', label: 'Rain' },
  { id: 'snow', label: 'Snow' },
] as const;

/** A background-effect id. */
export type BackgroundEffect = (typeof BACKGROUND_EFFECTS)[number]['id'];

/** Every background-effect id, for iteration / validation. */
export const BACKGROUND_EFFECT_IDS = BACKGROUND_EFFECTS.map((e) => e.id) as BackgroundEffect[];

/** The default background effect — `none`, so the shipped baseline paints nothing. */
export const DEFAULT_BACKGROUND_EFFECT: BackgroundEffect = 'none';

/** Coerce an arbitrary (stale/unknown) persisted value to a valid {@link BackgroundEffect}. */
export function normaliseBackgroundEffect(value: string): BackgroundEffect {
  return (BACKGROUND_EFFECT_IDS as readonly string[]).includes(value)
    ? (value as BackgroundEffect)
    : DEFAULT_BACKGROUND_EFFECT;
}
