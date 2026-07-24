/**
 * precip-engine — a GPU-composited particle system for the app-wide animated weather layer
 * (rain / snow). Framework-agnostic on purpose: {@link startPrecip} drives a single `<canvas>` and
 * returns a controller; the React wrapper
 * ({@link import('./BackgroundEffects').BackgroundEffects}) owns the element and its lifecycle.
 *
 * ## Look — a turbulent wind field, not a uniform drift
 *
 * Real falling rain and snow ride a gusting, swirling airflow; a constant lean or a single sine
 * sway reads as fake. Grounded in the standard real-time recipe (Perlin/curl-noise-driven particle
 * advection from the snow-scene and GPU-rain literature), every particle is advected through a live
 * wind field assembled in {@link ./flow-field} from cheap closed-form functions:
 *  - **Gusts** — a global wind ({@link gust}) eases the whole field one way, settles, then leans
 *    back the other. Rain slants with it; snow is pushed across the screen. Snow additionally
 *    feels **discrete gust events** ({@link gustPulse}): the aviation-standard 1-cosine ramp —
 *    a shove over a second or two, a slower die-away, then a shallow lull — layered over the
 *    smooth wander, so the wind has moments, not just moods.
 *  - **Flurries** — an intensity envelope ({@link flurry}) makes the weather pick up in surges and
 *    calm between them (harder wind, longer streaks, a touch denser).
 *  - **Turbulence & vortices** — a divergence-free curl field ({@link curlField}) plus a handful of
 *    transient {@link Vortex} eddies swirl flakes into curls and loops instead of a tidy diagonal.
 *    Eddies follow a **Rankine profile** (solid-body core, 1/r tail — calm eye, peak at the core
 *    edge) and live a **spin-up → peak → spin-down lifecycle** with hashed pauses between, so a
 *    calm spell occasionally carries a distinct visible swirl rather than a constant background
 *    stir; storms suppress them (hard wind shreds coherent eddies).
 *  - **Blizzards** (snow, issue #455) — a deterministic epoch-hashed scheduler ({@link blizzard})
 *    occasionally raises a storm: the whole field rakes near-horizontal (~80° off vertical, per
 *    the blizzard-geometry ground truth), flakes elongate into motion streaks, a reserve storm
 *    pool fades in so the fall visibly thickens, a whiteout haze veils the scene, and slow
 *    density "curtains" sweep across — then it all dies away and the calm drift returns.
 *
 * ## Look — the particles themselves
 *
 * Each kind pre-renders a *small set* of particle sprites once (see {@link buildSprites}) and every
 * particle picks one at spawn, so the field isn't a wall of identical dots:
 *  - **Rain** streaks are a bright thin core under a soft wide halo with a rounded, brighter head
 *    (the glassy look of a real drop), in two thicknesses. They **rotate to follow their velocity
 *    and elongate in the wind**, and fall in **depth layers** — distant drops are smaller, fainter
 *    and markedly slower than the fast, close foreground, so the field reads with real parallax. Two
 *    extra {@link TUNING.rain.deepLayers} sit further back still for a hazy, distant backdrop.
 *  - **Snow** is a mix of soft round grains (distant) and six-armed ice crystals — a plain star and
 *    a branched dendrite (nearer) — each crystal **slowly rotating** with a faint twinkle, so close
 *    flakes read as real snowflakes rather than blurry discs. The depth range runs wider than the
 *    crystals alone (issue #455): **deep background layers** (depth < 0) of tiny, slow, hazy grains
 *    sit behind the main field, and a sparse **foreground bokeh layer** (depth > 1) of big soft
 *    out-of-focus discs drifts fastest in front — the two ends of the parallax curve. Per-flake
 *    motion is grounded in the snow-physics literature: fall speed carries an **individual jitter
 *    decorrelated from sprite size** (real flake size barely predicts speed — the "big = fast"
 *    mapping is the classic fake tell), every flake **flutters** — a zigzag side-slip from wake
 *    vortex shedding, with the fall speed pulsing slower at the swing extremes — with branched
 *    dendrites deliberately fluttering least (lacy shapes are the aerodynamically stable ones),
 *    and downdraft-side turbulence settles flakes faster ("preferential sweeping").
 *
 * ## Look — a seasonal garnish
 *
 * On a handful of days a year the field also carries a few themed emoji (see {@link ./seasonal}):
 * presents through December's snow, a pumpkin around Halloween. They ride the same wind and curl
 * field as the snow — so they belong to the scene — but fall slower, rock gently instead of
 * spinning, and spend most of their life waiting off-screen ({@link Garnish.delay}), so what you
 * see is the occasional one drifting past rather than a second weather effect. Each glyph is
 * rasterised into a sprite **once** ({@link buildEmojiSprite}), so per frame the garnish costs
 * exactly what a snowflake costs: one `drawImage`.
 *
 * ## Performance — cheap, and composited entirely on the GPU
 *
 * The layer sits behind every screen, so it must be cheap and must never touch pixels on the CPU:
 *  - **Every frame is `drawImage` of a pre-rendered sprite.** The crystal/streak bitmaps are
 *    rasterised into offscreen canvases *once* (rebuilt only on a theme/colour or DPR change). Per
 *    frame we only blit a cached texture as a translated/rotated/scaled quad — the GPU-accelerated
 *    fast path in every modern browser. There is **no per-frame path building, filter, gradient or
 *    pixel work**, so all rasterisation and compositing happens on the GPU; the CPU only runs the
 *    tiny per-particle vector maths (a few hundred particles), which is negligible.
 *  - **Fixed particle pool, zero per-frame allocation.** Particles (and vortices) are created once
 *    (count scales with viewport area, hard-capped) and mutated in place; velocity is stashed on the
 *    particle so the draw pass reuses it. Recycling a particle reuses the same object.
 *  - **Delta-timed** so speed is frame-rate independent, with the step clamped so a background tab
 *    resuming after a long pause never "teleports" the field.
 *  - **Paused when the tab is hidden** (no wasted frames) and fully torn down on {@link stop}.
 *  - **DPR-capped** backing store so a 3× phone doesn't rasterise 9× the pixels.
 *
 * ## Look — the weather touches the UI (issue #68)
 *
 * Given an `overlay` canvas (stacked *above* the app content) and a {@link SurfaceTracker}, the
 * precipitation interacts with the controls on screen instead of falling obliviously behind them:
 *  - **Snow settles.** A near flake whose fall crosses the top edge of a control lands there: the
 *    flake is consumed and a per-column depth field grows, building rounded **mounds** on control
 *    tops over time (capped, edge-aware so drifts never smear across gaps between controls).
 *    Grounded in how snow actually behaves: a thin dusting is translucent and only turns opaque
 *    as depth builds ({@link SETTLE.snow.alpha}), the surface map follows rounded corners' arcs
 *    (see {@link import('./surface-map').buildSurfaceMap}), and deposits taper off steep faces
 *    per snow's angle of repose ({@link SETTLE.snow.slopeMax}) — so drifts hug a card's corner
 *    instead of shelving flatly across it.
 *  - **Rain splashes.** A near drop hitting a control top is consumed by a brief **splash** — an
 *    expanding ripple with a crown of kicked-up droplets — playing pre-rendered animation frames.
 *    Splashes are low and wide: the surface is seen nearly edge-on (a strongly foreshortened
 *    ripple ellipse), and a drop on a rigid surface throws a shallow crown, not a tall fountain.
 *
 * The same GPU discipline applies throughout: the collision test is one lookup into the tracker's
 * per-column {@link import('./surface-map')} table; splashes blit pre-rendered frame sprites; the
 * mound layer is re-painted into an offscreen canvas at most a few times a second (only when a
 * flake actually lands or the layout moves) and per frame is a single `drawImage` composite. Far
 * particles (and rain's deep-background layers) deliberately don't interact — they read as behind
 * the scene — which also throttles the landing rate. When the tracker reports the layout moved
 * (scroll, resize, DOM change), settled snow on moved surfaces is cleared, as if knocked off.
 *
 * Colours come from the `--precip-rain` / `--precip-snow` design tokens (read live, so the layer is
 * theme-correct); {@link PrecipController.refresh} re-reads them + rebuilds the sprites when the
 * theme changes. The layer is decorative — the caller marks the canvas `aria-hidden` — so under a
 * reduced-motion preference the engine paints a single calm static frame, never starts the loop,
 * and leaves the interaction layer entirely inert.
 */
import { gust, flurry, curlField, gustPulse, blizzard, blizzardWind, smooth01 } from './flow-field';
import { COLUMN_WIDTH, NO_SURFACE, type SurfaceSnapshot, type SurfaceTracker } from './surface-map';

/**
 * A seasonal garnish mixed into the falling field (see {@link ./seasonal}): on a handful of days
 * a few themed emoji drift down among the rain or snow. Sparse and slow by design — it should
 * read as a small surprise noticed in passing, not as a second weather effect.
 */
export interface GarnishOptions {
  /** The sprite set; each garnish particle picks one at spawn. */
  readonly emoji: readonly string[];
  /** Testing aid: many more pieces, spawning near-continuously, so the whole set is quick to see. */
  readonly dense?: boolean;
}

/** Which particle system the canvas runs. */
export type PrecipKind = 'rain' | 'snow';

/** Handle returned by {@link startPrecip} to control a running layer. */
export interface PrecipController {
  /** Re-read the theme colours and rebuild the sprites (call on a light/dark change). */
  refresh(): void;
  /** Stop the loop and detach every listener (idempotent). */
  stop(): void;
}

/** Options for {@link startPrecip}. */
export interface StartPrecipOptions {
  readonly kind: PrecipKind;
  /** When true (OS reduced-motion or the "Reduce effects" switch), paint one static frame only. */
  readonly reduced: boolean;
  /** Device-pixel-ratio cap for the backing store (default 2). */
  readonly dprCap?: number;
  /**
   * Optional interaction canvas stacked *above* the app content (issue #68). When given together
   * with {@link surfaces}, snow settles into mounds on control tops and rain splashes off them.
   * Ignored under `reduced` — the interaction layer is pure motion.
   */
  readonly overlay?: HTMLCanvasElement | null;
  /**
   * Factory for the live control-surface map (issue #68). A factory rather than an instance so
   * the engine only creates the tracker — and its DOM observers — when the interaction layer can
   * actually run (both canvases usable, motion allowed); a degraded start costs nothing. The
   * engine stops the tracker in {@link PrecipController.stop}.
   */
  readonly surfaces?: (() => SurfaceTracker) | null;
  /**
   * Optional seasonal emoji garnish drifting among the main field. Ignored under `reduced` — like
   * the interaction layer, it is pure motion.
   */
  readonly garnish?: GarnishOptions | null;
  /**
   * Run the garnish alone, with no rain/snow behind it (the lab's "garnish without a background
   * effect" flag). The base particle pool is left empty; everything else is unchanged.
   */
  readonly suppressBase?: boolean;
}

/** Per-kind tuning. `density` = viewport px² per particle (lower ⇒ denser), clamped to [min, max]. */
const TUNING = {
  rain: {
    density: 9000,
    min: 40,
    max: 240,
    /**
     * ── THE rain-speed knob ──────────────────────────────────────────────────────────────────
     * `fallSpeed` is the single value to change to make rain faster or slower: it is the foreground
     * (nearest) fall speed in css px/s, and *every other rain speed derives from it* — the distant
     * main layers fall {@link depthSpeedRatio} × `fallSpeed`, and the deep-background
     * {@link deepLayers} extrapolate slower still. So lowering this one number makes the whole field
     * gentler while keeping the depth parallax intact; raising it makes all layers faster together.
     */
    fallSpeed: 525,
    /**
     * The most-distant main layer falls this fraction of {@link fallSpeed}; a drop's actual fall
     * speed is lerped between `fallSpeed × depthSpeedRatio` (far) and `fallSpeed` (near) by its
     * depth. This controls how pronounced the depth→speed parallax is (smaller ⇒ a wider spread
     * between the fast foreground and the slow background), not the overall speed — change
     * {@link fallSpeed} for that. Streak *length* is deliberately NOT tied to fall speed (see
     * {@link windStretchGain}), so faster near-drops aren't drawn longer in a way that would mask
     * the very speed difference this creates.
     */
    depthSpeedRatio: 0.27,
    /** Baseline wind lean as a fraction of fall speed, before gusts. */
    baseLean: 0.1,
    /** Extra lean a full gust adds (fraction of fall speed); flurries amplify it. */
    gustLean: 0.34,
    /** Curl-turbulence drift (css px/s) — rain is heavy, so only a light jitter. */
    turb: 26,
    /** How strongly rain feels the eddies (heavy drops cut mostly straight through). */
    vortexFactor: 0.25,
    /** Streak sprite variants (core width / length, css px) so drops aren't all identical. */
    variants: [
      { width: 1.2, len: 17 },
      { width: 1.7, len: 22 },
    ] as const,
    /**
     * Wind-driven streak elongation. A streak's base length comes from its depth {@link scale}
     * (near = longer), and the wind then stretches it by `1 + lean·gain` (clamped to `max`) as it
     * slants — so gusts visibly rake drops out, but the stretch is the *same* factor at every depth
     * and therefore never masks the depth→speed parallax. `lean` here is the horizontal fraction of
     * the drop's velocity (|vx| / vy), which is depth-independent.
     */
    windStretchGain: 1.8,
    windStretchMax: 2.2,
    /** Depth-driven draw scale and alpha ranges (far → near); far is smaller + fainter to recede. */
    scale: [0.5, 1.15] as const,
    alpha: [0.16, 0.62] as const,
    /**
     * Two extra depth layers sitting *further back* than the main field. Their depth params are
     * negative, so the shared speed/scale/alpha lerps extrapolate to slower and smaller drops — a
     * distant backdrop behind the main rain. A slice of the field ({@link deepLayerFraction}) is
     * placed in these layers, added *on top of* the main count so the foreground isn't thinned;
     * {@link deepLayerJitter} spreads each layer's depth a touch so its drops don't fall in
     * lockstep. Their opacity is lifted by {@link deepAlphaBoost} — the raw alpha extrapolation
     * would fade them to near-invisible, so this keeps them faintly but genuinely visible while the
     * (unchanged) smaller size and slower speed still read as depth.
     */
    deepLayers: [-0.1, -0.2] as const,
    deepLayerFraction: 0.18,
    deepLayerJitter: 0.02,
    deepAlphaBoost: 0.15,
  },
  snow: {
    density: 15000,
    min: 30,
    max: 150,
    speed: [34, 92] as const,
    /**
     * Per-flake fall-speed jitter (multiplier range), decorrelated from the flake's sprite and
     * scale. Grounded in the disdrometer literature: a real flake's size barely predicts its
     * fall speed (v ∝ D^~0.2 for dendrites/plates), so two same-looking flakes falling at
     * different speeds is *correct* — while a strict "big = fast" mapping is the classic tell.
     * Depth (z) still scales speed, because that parallax is a perspective cue, not a size one.
     */
    speedJitter: [0.78, 1.25] as const,
    /** Peak sideways wind a full gust imparts (css px/s), scaled by flurry + depth. */
    wind: 74,
    /** Peak sideways shove of a full discrete gust event ({@link gustPulse}), css px/s. */
    pulseWind: 130,
    /** Curl-turbulence drift (css px/s) — snow is light, so it swirls freely. */
    turb: 40,
    /** Snow rides the eddies fully. */
    vortexFactor: 1,
    /** Cap on horizontal speed as a multiple of fall speed (never pure sideways flight). */
    maxDriftRatio: 2.4,
    /**
     * Flutter — the zigzag side-slip of a falling flake (wake vortex shedding). `rate` is the
     * per-flake swing frequency range (rad/s ≈ 0.5–1.3 Hz, the falling-plate Strouhal band);
     * `amp` the peak side-slip speed (css px/s); `fallPulse` how much the fall speed dips at the
     * swing extremes (real zigzagging couples the two — a swinging flake visibly hesitates).
     */
    flutterRate: [3, 8] as const,
    flutterAmp: 26,
    flutterFallPulse: 0.18,
    /**
     * Preferential sweeping: turbulence channels flakes down the downdraft side of eddies, so
     * downward curl contributions act this much stronger than upward ones — field PIV studies
     * show snow settling notably faster than still-air terminal velocity for exactly this reason.
     */
    sweep: 0.35,
    /** Grain (soft disc) radius in css px, for the small distant flakes. */
    grainRadius: 3,
    /** Ice-crystal arm length in css px, for the larger near flakes. */
    crystalArm: 8,
    /** Below this depth a flake is a plain grain; at/above it, a rotating crystal. */
    grainMaxZ: 0.4,
    /** Crystal spin range (rad/s); the sign is the spin direction. */
    spin: [-0.7, 0.7] as const,
    /** Twinkle: shimmer speed (rad/s) and depth (fraction of alpha removed at the dimmest). */
    twinkleSpeed: 1.6,
    twinkleAmp: 0.14,
    scale: [0.45, 1.3] as const,
    alpha: [0.32, 0.9] as const,
    /**
     * Deep background layers (depth < 0), mirroring rain's: a slice of the field extrapolates to
     * tiny, slow, faint grains — the hazy far backdrop that widens the parallax range downward.
     * Like rain's, they're added on top of the main count and get an alpha lift so the raw
     * extrapolation doesn't fade them to nothing.
     */
    deepLayers: [-0.12, -0.24] as const,
    deepLayerFraction: 0.15,
    deepLayerJitter: 0.03,
    deepAlphaBoost: 0.12,
    /**
     * Foreground bokeh layer (depth > 1): a sparse handful of big, soft, *low-alpha* out-of-focus
     * discs drifting fastest of all — the camera-side end of the parallax curve (a flake between
     * the viewer and the "focal plane" of the UI). Kept few and faint on purpose: each one covers
     * a lot of screen (overdraw), and defocused things are dimmer, not brighter. `alpha` runs
     * [nearer edge → furthest-forward] — the closer to the viewer, the more defocused and fainter.
     */
    bokeh: {
      fraction: 0.05,
      z: [1.08, 1.3] as const,
      radius: 9,
      alpha: [0.3, 0.16] as const,
    },
    /**
     * Blizzard behaviour, driven by the {@link blizzard} envelope. Wind strong enough to rake
     * near flakes ~75–80° off vertical (real blizzard trajectories run 80–87°, softened here —
     * this is an ambient backdrop, not a survival sim); the drift-ratio cap relaxes to let that
     * happen; flakes elongate into motion streaks with speed; a reserve pool ({@link extra} ×
     * the base count) fades in so the fall thickens; a whiteout haze veils the scene; and slow
     * density "curtains" ({@link waveAmp}…) sweep across the field like real turbulent sheets.
     */
    storm: {
      extra: 0.8,
      wind: 480,
      fallBoost: 0.35,
      /** maxDriftRatio multiplier grows to (1 + this) at full storm — near-horizontal flight. */
      driftBoost: 1.6,
      /** Peak whiteout-haze opacity at full storm. */
      hazeAlpha: 0.17,
      /** Motion-streak elongation: stretch = 1 + storm · gain · (|vx|/vy), capped. */
      streakGain: 0.55,
      streakMax: 2.6,
      /** Density curtains: ± alpha modulation, spatial wavelength (css px), sweep rate (rad/s). */
      waveAmp: 0.35,
      waveLength: 480,
      waveSpeed: 0.9,
    },
  },
} as const;

/**
 * Seasonal-garnish tuning. The pool is tiny and each piece waits out a {@link gap} before it
 * re-enters, so the *visible* count is far lower again than `max` — the garnish is meant to be
 * glimpsed. `dense` collapses the gap and lifts the count for testing.
 */
const GARNISH = {
  /** One piece per this many viewport px², clamped — an order of magnitude sparser than snow. */
  density: 420_000,
  min: 2,
  max: 5,
  /** Testing multipliers applied to the pool size, and the gap the pieces wait between passes. */
  denseCountFactor: 6,
  denseGap: [0, 0.6] as const,
  /** Seconds a recycled piece waits off-screen before falling again (min, max). */
  gap: [4, 26] as const,
  /** Emoji glyph size in css px at full depth, before the depth scale. */
  size: 26,
  /** Fall speed range (far → near), css px/s. Slower than snow: these are big, light and gentle. */
  speed: [26, 62] as const,
  /** Peak sideways wind a full gust imparts (css px/s). */
  wind: 46,
  /** Curl-turbulence drift (css px/s). */
  turb: 26,
  /** Depth range: the garnish never sits in the far haze, or it would be unreadable. */
  z: [0.4, 1] as const,
  scale: [0.65, 1.1] as const,
  alpha: [0.5, 0.92] as const,
  /**
   * The garnish rocks rather than spins: a full tumble reads as a falling icon, while a slow
   * sway ±{@link tilt} radians reads as something light drifting down. `sway` is the rocking rate
   * (rad/s of phase); the sign of a piece's own rate sets which way it starts.
   */
  sway: [-0.9, 0.9] as const,
  tilt: 0.34,
} as const;

/**
 * Font stack for the garnish sprites: the platform emoji font, with a generic `emoji` fallback so
 * a system without any of the named families still rasterises a glyph rather than tofu.
 */
const EMOJI_FONT =
  '"Apple Color Emoji", "Segoe UI Emoji", "Noto Color Emoji", "Twemoji Mozilla", sans-serif, emoji';

/**
 * Vortex-cell tuning: transient eddies that drift with the wind. Each eddy lives a lifecycle —
 * a hashed off-time, then spin-up → peak → spin-down ({@link life} / {@link ramp}) — so swirls
 * are occasional *events* in a calm spell rather than a constant background stir, matching how
 * real snow devils and shear eddies appear, whirl for seconds, and dissipate. The velocity
 * profile is a Rankine vortex (solid-body {@link core}, 1/r tail): dead-calm eye, peak at the
 * core edge — the profile that makes a swirl read as a swirl instead of a smear.
 */
const VORTEX = {
  /** One eddy per this many viewport px², clamped. */
  density: 320_000,
  min: 1,
  max: 3,
  /** Eddy radius range (css px) — the outer influence radius. */
  radius: [130, 320] as const,
  /** Peak tangential speed range (css px/s) at the core edge. */
  peak: [60, 130] as const,
  /** Core radius as a fraction of the influence radius (solid-body inside, 1/r outside). */
  core: 0.35,
  /** Lifecycle: active life range (s), spin-up/down ramp (s), and off-time between lives (s). */
  life: [6, 14] as const,
  ramp: 2,
  gap: [3, 14] as const,
  /** How much a full blizzard suppresses eddies (hard straight wind shreds coherent swirls). */
  stormDamp: 0.6,
  /** How much a dead-calm spell (no flurry) amplifies them — the calm-air swirl moment. */
  calmBoost: 0.35,
  /** How fast an eddy sinks through the field (css px/s). */
  sink: 20,
  /** How far a full gust carries an eddy sideways (css px/s) — shared by rain and snow. */
  drift: 30,
} as const;

/**
 * Control-interaction tuning (issue #68): how snow settles on control tops and rain splashes off
 * them. Landing eligibility is depth-gated so the far field keeps falling "behind" the scene —
 * which both preserves the depth illusion and throttles the landing rate for free.
 */
const SETTLE = {
  /** A surface top may drift this many px between map rebuilds and keep its snow (rounding). */
  moveTolerance: 2,
  snow: {
    /** Only nearer flakes (depth ≥ this) settle; far ones pass behind the UI untouched. */
    minZ: 0.35,
    /** Depth added at the landing column per settled flake (css px)… */
    deposit: 1.1,
    /** …spread over neighbouring columns by distance (tiny lookup table, index = |offset|). */
    kernel: [1, 0.6, 0.25] as const,
    /** Mound height cap (css px): build-up visibly grows over time, then holds. */
    maxDepth: 9,
    /** Depth below which a column isn't worth drawing (css px). */
    minVisibleDepth: 0.4,
    /** Min seconds between mound-layer re-renders (per frame the layer is one cached blit). */
    renderInterval: 0.15,
    /**
     * Mound opacity by depth (thin → deep). Fresh snow is translucent while it's a dusting and
     * only reads opaque once real depth builds — so a new drift fades in and thickens instead of
     * popping in solid white. Applied per column (√-eased) via the run's fill gradient.
     */
    alpha: [0.25, 0.85] as const,
    /** Crest-highlight opacity by depth (same √-eased ramp as the fill). */
    crestAlpha: [0.15, 0.9] as const,
    /**
     * Deposits scale down with the local surface slope and stop entirely past `slopeMax`
     * (rise/run ≈ 1.2 ≈ 50°): snow doesn't stick to steep faces — it slides off — which is what
     * makes drifts taper naturally around a rounded corner instead of shelving across it. (Dry
     * snow's angle of repose is ~35–40°; the extra headroom keeps gentle shoulders collecting.)
     */
    slopeMax: 1.2,
  },
  rain: {
    /** Only near drops (depth ≥ this) splash; far and deep-background drops don't interact. */
    minZ: 0.55,
    /** Splash lifetime range (s). */
    life: [0.26, 0.42] as const,
    /** Pre-rendered animation frames per splash variant (the sprite lookup table). */
    frames: 6,
    /** Hard cap on concurrently-animating splashes (also the fixed pool size). */
    maxSplashes: 48,
    /** Draw scale range by drop depth (near drops splash bigger). */
    scale: [0.7, 1.15] as const,
  },
} as const;

/**
 * The largest step (css px) between adjacent columns that still reads as one continuous drift
 * surface — anything walkable at less than the {@link SETTLE.snow.slopeMax} repose cutoff.
 * Shared by kernel spread, mound-run joining, and the slope model, so "same drift" means one
 * thing everywhere.
 */
const SNOW_JOIN_STEP = SETTLE.snow.slopeMax * COLUMN_WIDTH;

/**
 * Adjacent-column steps beyond {@link SNOW_JOIN_STEP} but under this are treated as a steep face
 * of the same surface (a corner's flank — snow sheds); steps beyond it are a discontinuity
 * between different controls (a cliff), which says nothing about the column's own steepness.
 */
const SNOW_CLIFF_STEP = SNOW_JOIN_STEP * 3;

/**
 * Splash sprite geometry (css px): frame size and the y of the impact line within the frame.
 * Deliberately low and wide: control tops are seen almost edge-on, so the ripple ellipse is
 * strongly foreshortened, and a drop hitting a rigid surface throws a low, wide crown (thin
 * radial lamella with droplets ejected at shallow angles) rather than a tall fountain.
 */
const SPLASH_W = 40;
const SPLASH_H = 12;
const SPLASH_BASELINE = 8;
/** Vertical foreshortening of the ripple ellipse (ry : rx) for the near-edge-on viewpoint. */
const SPLASH_FLATTEN = 0.16;

/** Fallbacks if the token can't be read (kept close to the dark-theme values). */
const FALLBACK_COLOR: Record<PrecipKind, string> = {
  rain: 'oklch(0.82 0.045 240)',
  snow: 'oklch(0.97 0.006 250)',
};

/** Largest delta-time step honoured per frame (s) — caps a resume-from-hidden jump. */
const MAX_STEP = 0.05;

interface Particle {
  x: number;
  y: number;
  /**
   * Depth: the main field spans [0, 1] (0 = far: small/slow/faint, 1 = near: large/fast/opaque).
   * Snow and rain extrapolate below 0 for the deep background layers; snow also extrapolates
   * above 1 for the foreground bokeh layer.
   */
  z: number;
  /** Velocity this frame (css px/s), stashed by the step pass for the draw pass to reuse. */
  vx: number;
  vy: number;
  /** Index into the kind's sprite set (which streak thickness / flake shape this particle is). */
  variant: number;
  /** Spin rate (rad/s) for a rotating crystal; 0 for grains/rain. */
  spin: number;
  /** Random phase for spin start + twinkle + flutter, so flakes are decorrelated. */
  phase: number;
  /** Per-flake fall-speed jitter multiplier (snow; 1 for rain) — see TUNING.snow.speedJitter. */
  jitter: number;
  /** Flutter swing frequency (rad/s) and peak side-slip speed (css px/s); 0/0 for rain. */
  flutter: number;
  flutterAmp: number;
  /** Reserve storm-pool member: dormant (not stepped, not drawn) until a blizzard fades it in. */
  storm: boolean;
}

/** One splash animation in flight. Pooled: `t >= life` marks a free slot. */
interface Splash {
  x: number;
  y: number;
  /** Elapsed / total lifetime (s). */
  t: number;
  life: number;
  /** Draw scale, fixed at spawn from the landing drop's depth. */
  scale: number;
  /** Which pre-rendered frame set this splash plays. */
  variant: number;
}

/**
 * One seasonal-garnish piece. A plain particle plus the pause it sits out off-screen between
 * passes — what keeps a pool of five emoji reading as the occasional one drifting by.
 */
interface Garnish extends Particle {
  /** Seconds still to wait before this piece falls again; while positive it isn't drawn. */
  delay: number;
}

/** A drifting eddy that adds a tangential swirl to nearby particles. */
interface Vortex {
  x: number;
  y: number;
  /** Radius (css px) and its square (precomputed for the distance test). */
  r: number;
  r2: number;
  /** Signed peak tangential speed (css px/s); the sign is the spin direction. */
  peak: number;
  /** Lifecycle: seconds waited before this life starts, age so far, and total active life (s). */
  delay: number;
  age: number;
  life: number;
  /** Effective strength this frame (lifecycle envelope × weather), cached by the advance pass. */
  strength: number;
}

/** A pre-rendered particle bitmap plus its half-extent in css px (for centring the blit). */
interface Sprite {
  canvas: HTMLCanvasElement;
  halfW: number;
  halfH: number;
}

/** Snow sprite-set indices. Grains/bokeh are angularly symmetric (no rotation); crystals rotate. */
const SNOW_GRAIN = 0;
/** The foreground out-of-focus disc (depth > 1). */
const SNOW_BOKEH = 3;

/** Uniform random in [min, max). Positions/timings only — no security concern. */
function rand(min: number, max: number): number {
  return min + Math.random() * (max - min);
}

/** Linear interpolate. */
function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/** Clamp `v` into [min, max]. */
function clamp(v: number, min: number, max: number): number {
  return v < min ? min : v > max ? max : v;
}

/** Resolve a CSS custom property on `<html>` to its computed value, with a fallback. */
function readToken(name: string, fallback: string): string {
  if (typeof getComputedStyle !== 'function') return fallback;
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return value || fallback;
}

/**
 * Wrap a CSS colour so it renders at a given alpha, without parsing it: `color-mix` blends it
 * toward `transparent`. Supported wherever the app runs (the token values are already `oklch`).
 */
function colorWithAlpha(color: string, alpha: number): string {
  return `color-mix(in oklab, ${color} ${Math.round(alpha * 100)}%, transparent)`;
}

/** Allocate a css-sized offscreen canvas with a DPR-scaled backing store, ready to draw into. */
function makeCanvas(
  cssW: number,
  cssH: number,
  dpr: number,
): [HTMLCanvasElement, CanvasRenderingContext2D | null] {
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(cssW * dpr));
  c.height = Math.max(1, Math.round(cssH * dpr));
  const g = c.getContext('2d');
  if (g) g.scale(dpr, dpr);
  return [c, g];
}

/**
 * Build a rain-streak sprite for one thickness: a bright thin core over a soft wide halo, with a
 * rounded brighter head at the leading (bottom) tip. Drawn vertical; the engine rotates it to the
 * drop's velocity at draw time, so the wind slant is live rather than baked in.
 */
function buildRainStreak(dpr: number, color: string, width: number, len: number): HTMLCanvasElement {
  const headR = width * 1.4;
  const topPad = width * 1.6;
  const botPad = Math.max(width * 1.6, headR + 1);
  const halo = width * 2.4;
  const w = Math.ceil(halo + 2);
  const h = Math.ceil(len + topPad + botPad);
  const [c, g] = makeCanvas(w, h, dpr);
  if (g) {
    const cx = w / 2;
    const top = topPad;
    const bottom = topPad + len;
    g.lineCap = 'round';
    // Soft wide halo — the drop's glassy blur.
    const gh = g.createLinearGradient(cx, top, cx, bottom);
    gh.addColorStop(0, 'transparent');
    gh.addColorStop(0.4, colorWithAlpha(color, 0.1));
    gh.addColorStop(1, colorWithAlpha(color, 0.22));
    g.strokeStyle = gh;
    g.lineWidth = halo;
    g.beginPath();
    g.moveTo(cx, top);
    g.lineTo(cx, bottom);
    g.stroke();
    // Bright thin core.
    const gc = g.createLinearGradient(cx, top, cx, bottom);
    gc.addColorStop(0, 'transparent');
    gc.addColorStop(0.3, colorWithAlpha(color, 0.4));
    gc.addColorStop(1, color);
    g.strokeStyle = gc;
    g.lineWidth = width;
    g.beginPath();
    g.moveTo(cx, top);
    g.lineTo(cx, bottom);
    g.stroke();
    // Rounded, brighter head at the leading tip.
    const gr = g.createRadialGradient(cx, bottom, 0, cx, bottom, headR);
    gr.addColorStop(0, color);
    gr.addColorStop(0.5, colorWithAlpha(color, 0.6));
    gr.addColorStop(1, 'transparent');
    g.fillStyle = gr;
    g.beginPath();
    g.arc(cx, bottom, headR, 0, Math.PI * 2);
    g.fill();
  }
  return c;
}

/** Build the soft snow-grain sprite: a radial gradient disc that fades to transparent. */
function buildSnowGrain(dpr: number, color: string): HTMLCanvasElement {
  const r = TUNING.snow.grainRadius;
  const size = Math.ceil(r * 4);
  const [c, g] = makeCanvas(size, size, dpr);
  if (g) {
    const cx = size / 2;
    const grad = g.createRadialGradient(cx, cx, 0, cx, cx, r * 1.8);
    grad.addColorStop(0, color);
    grad.addColorStop(0.5, colorWithAlpha(color, 0.55));
    grad.addColorStop(1, 'transparent');
    g.fillStyle = grad;
    g.beginPath();
    g.arc(cx, cx, r * 1.8, 0, Math.PI * 2);
    g.fill();
  }
  return c;
}

/**
 * Build the foreground bokeh sprite: a big, soft out-of-focus disc — mostly flat through the
 * middle with a faint brighter rim (the signature of a defocused point light) and a soft fade
 * to nothing. Alpha stays modest; defocus dims, and the engine dims it further with depth.
 */
function buildSnowBokeh(dpr: number, color: string): HTMLCanvasElement {
  const r = TUNING.snow.bokeh.radius;
  const size = Math.ceil(r * 2.6);
  const [c, g] = makeCanvas(size, size, dpr);
  if (g) {
    const cx = size / 2;
    const grad = g.createRadialGradient(cx, cx, 0, cx, cx, r * 1.25);
    grad.addColorStop(0, colorWithAlpha(color, 0.5));
    grad.addColorStop(0.62, colorWithAlpha(color, 0.46));
    grad.addColorStop(0.82, colorWithAlpha(color, 0.56));
    grad.addColorStop(1, 'transparent');
    g.fillStyle = grad;
    g.beginPath();
    g.arc(cx, cx, r * 1.25, 0, Math.PI * 2);
    g.fill();
  }
  return c;
}

/**
 * Build the blizzard whiteout haze: a narrow vertical-gradient strip the engine stretches over
 * the whole viewport (the gradient only varies vertically, so the horizontal stretch is free).
 * Rendered once per theme/DPR change; per frame the haze is a single `drawImage` whose
 * `globalAlpha` rides the storm envelope — no per-frame gradient work.
 */
function buildSnowHaze(dpr: number, color: string): HTMLCanvasElement {
  const w = 8;
  const h = 256;
  const [c, g] = makeCanvas(w, h, dpr);
  if (g) {
    const grad = g.createLinearGradient(0, 0, 0, h);
    grad.addColorStop(0, colorWithAlpha(color, 0.9));
    grad.addColorStop(0.55, colorWithAlpha(color, 0.62));
    grad.addColorStop(1, colorWithAlpha(color, 0.48));
    g.fillStyle = grad;
    g.fillRect(0, 0, w, h);
  }
  return c;
}

/**
 * Build a six-armed ice-crystal sprite. `dendrite` adds side-branches to each arm (a fuller
 * snowflake); otherwise it's a plain six-point star. A faint central glow and bright core dot give
 * it body. Drawn small and soft so at background scale it reads as a delicate flake, not an icon.
 */
function buildSnowCrystal(dpr: number, color: string, dendrite: boolean): HTMLCanvasElement {
  const arm = TUNING.snow.crystalArm;
  const pad = 2;
  const size = Math.ceil(arm * 2 + pad * 2);
  const [c, g] = makeCanvas(size, size, dpr);
  if (g) {
    const cx = size / 2;
    g.lineCap = 'round';
    g.lineJoin = 'round';
    // Faint central glow.
    const glow = g.createRadialGradient(cx, cx, 0, cx, cx, arm * 0.55);
    glow.addColorStop(0, colorWithAlpha(color, 0.5));
    glow.addColorStop(1, 'transparent');
    g.fillStyle = glow;
    g.beginPath();
    g.arc(cx, cx, arm * 0.55, 0, Math.PI * 2);
    g.fill();
    // Six arms, fading from bright at the hub to faint at the tips.
    for (let i = 0; i < 6; i++) {
      const a = (i * Math.PI) / 3;
      const ex = cx + Math.cos(a) * arm;
      const ey = cx + Math.sin(a) * arm;
      const ga = g.createLinearGradient(cx, cx, ex, ey);
      ga.addColorStop(0, colorWithAlpha(color, 0.85));
      ga.addColorStop(1, colorWithAlpha(color, 0.1));
      g.strokeStyle = ga;
      g.lineWidth = 1.1;
      g.beginPath();
      g.moveTo(cx, cx);
      g.lineTo(ex, ey);
      g.stroke();
      if (dendrite) {
        g.strokeStyle = colorWithAlpha(color, 0.5);
        g.lineWidth = 0.9;
        for (const f of [0.5, 0.72]) {
          const bx = cx + Math.cos(a) * arm * f;
          const by = cx + Math.sin(a) * arm * f;
          const blen = arm * (f === 0.5 ? 0.34 : 0.22);
          for (const s of [-1, 1]) {
            const ba = a + (s * Math.PI) / 3;
            g.beginPath();
            g.moveTo(bx, by);
            g.lineTo(bx + Math.cos(ba) * blen, by + Math.sin(ba) * blen);
            g.stroke();
          }
        }
      }
    }
    // Bright core dot.
    g.fillStyle = color;
    g.beginPath();
    g.arc(cx, cx, 1.1, 0, Math.PI * 2);
    g.fill();
  }
  return c;
}

/**
 * Build one pre-rendered splash animation frame: an expanding elliptical ripple flattened onto the
 * surface line, a fading vertical impact spike, and a small crown of droplets that arc up, out and
 * back down across the frames. `q` is normalised progress (0..1); `variant` decorrelates the
 * droplet pattern so neighbouring splashes don't read as clones. All alpha is baked into the
 * frames, so the engine plays a splash with nothing but plain `drawImage` calls.
 */
function buildSplashFrame(dpr: number, color: string, variant: number, q: number): HTMLCanvasElement {
  const [c, g] = makeCanvas(SPLASH_W, SPLASH_H, dpr);
  if (g) {
    const cx = SPLASH_W / 2;
    const by = SPLASH_BASELINE;
    const fade = 1 - q;
    // Expanding ripple ring, strongly foreshortened into the surface plane (near-edge-on view).
    const rx = 2.5 + 13 * q;
    g.strokeStyle = colorWithAlpha(color, 0.12 + 0.5 * fade);
    g.lineWidth = 1.5 - 0.8 * q;
    g.beginPath();
    g.ellipse(cx, by, rx, rx * SPLASH_FLATTEN, 0, 0, Math.PI * 2);
    g.stroke();
    // A second, trailing ripple once the first has spread.
    if (q > 0.3) {
      g.strokeStyle = colorWithAlpha(color, 0.3 * fade);
      g.lineWidth = 1;
      g.beginPath();
      g.ellipse(cx, by, rx * 0.55, rx * SPLASH_FLATTEN * 0.55, 0, 0, Math.PI * 2);
      g.stroke();
    }
    // Impact spike, brightest at the instant of the hit — short: the crown stays low on a rigid
    // surface, there is no tall fountain.
    if (q < 0.4) {
      const s = 1 - q / 0.4;
      g.strokeStyle = colorWithAlpha(color, 0.5 * s);
      g.lineWidth = 1.1;
      g.beginPath();
      g.moveTo(cx, by);
      g.lineTo(cx, by - 3.2 * s - 0.8);
      g.stroke();
    }
    // Crown droplets, ejected at shallow angles: they spread wide and stay low, arcing out and
    // back down over the animation.
    const count = 4 + (variant % 2);
    const rise = Math.sin(Math.min(1, q * 1.15) * Math.PI);
    g.fillStyle = colorWithAlpha(color, 0.65 * fade);
    for (let i = 0; i < count; i++) {
      const fx = (i / (count - 1)) * 2 - 1;
      const dx = fx * (6 + 12 * q);
      const dy = -rise * (2.6 + ((i * 2 + variant) % 3) * 0.8);
      g.beginPath();
      g.arc(cx + dx, by + dy, 0.75, 0, Math.PI * 2);
      g.fill();
    }
  }
  return c;
}

/**
 * Rasterise one emoji into its own sprite canvas. This runs **once per glyph** (and again only on
 * a DPR change), which is the entire point: text layout and colour-glyph rasterisation are far too
 * expensive to do per frame, so the garnish pays for them at build time and every frame afterwards
 * is the same plain `drawImage` blit as the rain and snow sprites.
 */
function buildEmojiSprite(dpr: number, emoji: string): HTMLCanvasElement {
  const size = GARNISH.size;
  // Emoji routinely overflow their nominal em box (and the glyph is centred in the canvas), so the
  // sprite is padded generously rather than clipping a pumpkin's stalk.
  const box = Math.ceil(size * 1.4);
  const [c, g] = makeCanvas(box, box, dpr);
  if (g) {
    g.font = `${size}px ${EMOJI_FONT}`;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText(emoji, box / 2, box / 2);
  }
  return c;
}

export function startPrecip(canvas: HTMLCanvasElement, opts: StartPrecipOptions): PrecipController {
  const { kind, reduced } = opts;
  const dprCap = opts.dprCap ?? 2;
  const ctx = canvas.getContext('2d');
  // No 2D context (very old browser or a jsdom test): nothing to do — a no-op controller keeps the
  // caller's lifecycle simple and the app fully functional without the decoration.
  if (!ctx) return { refresh: () => {}, stop: () => {} };

  const overlay = opts.overlay ?? null;
  const octx = overlay ? overlay.getContext('2d') : null;
  // The interaction layer (issue #68) runs only with both halves usable and motion allowed —
  // only then is the surface tracker created at all, so its DOM observers never run unconsumed.
  const suppressBase = opts.suppressBase === true;
  // With no rain or snow in the pool nothing can ever settle or splash — the garnish deliberately
  // doesn't land — so a garnish-only run skips the tracker rather than installing its
  // document-wide observers to serve a layer that can never paint a pixel.
  const surfaces = octx && !reduced && !suppressBase && opts.surfaces ? opts.surfaces() : null;
  const interact = surfaces !== null;
  // The garnish is pure motion (its whole read is "something drifted past"), so a static frame
  // leaves it out entirely rather than freezing emoji mid-air over the calm field.
  const garnishOpts = !reduced && opts.garnish && opts.garnish.emoji.length > 0 ? opts.garnish : null;

  let dpr = 1;
  let cssWidth = 0;
  let cssHeight = 0;
  let sprites: Sprite[] = [];
  /** Largest sprite half-height across the set (for the off-screen margin + recycle test). */
  let spriteMaxHalfH = 0;
  let particles: Particle[] = [];
  let vortices: Vortex[] = [];
  /** Pre-rendered emoji sprites for the seasonal garnish (empty when there is no garnish). */
  let garnishSprites: Sprite[] = [];
  let garnishes: Garnish[] = [];
  /** DPR the garnish sprites were rasterised at (-1 = never), so a refresh doesn't redo the work. */
  let garnishDpr = -1;
  /** Largest garnish sprite half-height, for its own off-screen margin (emoji dwarf a flake). */
  let garnishMaxHalfH = 0;
  let rafId = 0;
  let lastTime = 0;
  let resizeQueued = false;
  let stopped = false;
  let elapsed = 0;
  // Wind context for the current frame — computed once per frame, read by every particle.
  let frameGust = 0;
  let frameFlurry = 0;
  /** Blizzard envelope [0,1], its signed wind, and the discrete gust pulse (snow only; else 0). */
  let frameStorm = 0;
  let frameStormWind = 0;
  let framePulse = 0;
  /** The blizzard whiteout-haze strip (snow only), stretched over the viewport per frame. */
  let hazeSprite: Sprite | null = null;
  /** How far off each edge a particle travels before it wraps/recycles (kept fully off-screen). */
  let edgeMargin = 0;
  /**
   * Vertical spawn/recycle margin: the largest *drawn* particle half-height (sprite half-height ×
   * the depth-extrapolated max scale × any streak stretch), so a foreground bokeh disc or a
   * storm-stretched streak leaves the bottom edge fully before it recycles and never spawns with
   * a sliver already on screen.
   */
  let vertMargin = 0;

  // ── Interaction-layer state (issue #68) ──────────────────────────────────────────────────
  /** The adopted surface map — the tracker's own array (swapped on rebuild, never mutated). */
  let surfTops: Int16Array = new Int16Array(0);
  /** Tracker generation the map was adopted at; -1 forces adoption on the next frame. */
  let surfGen = -1;
  /** Settled-snow depth per column (css px). */
  let depths = new Float32Array(0);
  /** Whether the last mound render actually drew anything (skips the per-frame blit when not). */
  let moundVisible = false;
  /** The mound layer needs re-rendering (a flake landed, the layout moved, or the theme changed). */
  let moundDirty = false;
  let lastMoundRender = -Infinity;
  /** True while the overlay canvas holds no pixels, so blank frames skip even the clear. */
  let overlayClean = true;
  /** Offscreen cache the mound shapes are path-rendered into (a few times/s at most). */
  let moundCanvas: HTMLCanvasElement | null = null;
  let moundCtx: CanvasRenderingContext2D | null = null;
  /** Theme colour the mound layer paints with (captured alongside the sprites). */
  let overlayColor = FALLBACK_COLOR[kind];
  /** Pre-rendered splash animation frames, [variant][frame]. */
  let splashFrames: Sprite[][] = [];
  /** Fixed splash pool, allocated once; a slot with `t >= life` is free for reuse. */
  const splashes: Splash[] =
    interact && kind === 'rain'
      ? Array.from({ length: SETTLE.rain.maxSplashes }, () => ({
          x: 0,
          y: 0,
          t: 0,
          life: 0,
          scale: 0,
          variant: 0,
        }))
      : [];

  function toSprite(c: HTMLCanvasElement): Sprite {
    return { canvas: c, halfW: c.width / dpr / 2, halfH: c.height / dpr / 2 };
  }

  function buildSprites(): void {
    const color = readToken(kind === 'rain' ? '--precip-rain' : '--precip-snow', FALLBACK_COLOR[kind]);
    if (kind === 'rain') {
      sprites = TUNING.rain.variants.map((v) => toSprite(buildRainStreak(dpr, color, v.width, v.len)));
    } else {
      sprites = [
        toSprite(buildSnowGrain(dpr, color)),
        toSprite(buildSnowCrystal(dpr, color, false)),
        toSprite(buildSnowCrystal(dpr, color, true)),
        toSprite(buildSnowBokeh(dpr, color)), // SNOW_BOKEH
      ];
      hazeSprite = toSprite(buildSnowHaze(dpr, color));
    }
    spriteMaxHalfH = sprites.reduce((m, s) => Math.max(m, s.halfH), 0);
    // Streaks stretch (rain in the wind, snow in a blizzard) and every sprite scales up with
    // depth, so the margin uses the largest drawn half-height to keep a particle fully
    // off-screen before it wraps.
    const maxStretch = kind === 'rain' ? TUNING.rain.windStretchMax : TUNING.snow.storm.streakMax;
    // Emoji sprites take no colour from the theme, so — unlike the rain/snow sprites around them —
    // they survive a `refresh()` untouched and are only ever rasterised again for a new DPR.
    if (garnishOpts && (garnishSprites.length === 0 || garnishDpr !== dpr)) {
      garnishSprites = garnishOpts.emoji.map((e) => toSprite(buildEmojiSprite(dpr, e)));
      garnishMaxHalfH = garnishSprites.reduce((m, s) => Math.max(m, s.halfH), 0);
      garnishDpr = dpr;
    }
    // The margin has to keep the *largest* drawn thing fully off-screen before it wraps, and a
    // garnish emoji is several times a flake's size — so both sprite sets are measured here.
    // Snow's largest draw scale isn't scale[1]: the bokeh layer extrapolates beyond depth 1.
    const t = TUNING[kind];
    const maxScale = kind === 'snow' ? lerp(t.scale[0], t.scale[1], TUNING.snow.bokeh.z[1]) : t.scale[1];
    edgeMargin =
      Math.max(spriteMaxHalfH * 2 * maxScale * maxStretch, garnishMaxHalfH * 2 * GARNISH.scale[1]) + 8;
    vertMargin = spriteMaxHalfH * maxScale * maxStretch + 4;
    if (interact) {
      overlayColor = color;
      if (kind === 'rain') {
        // The splash frame lookup table: every animation frame of both variants, rendered once.
        splashFrames = [0, 1].map((variant) =>
          Array.from({ length: SETTLE.rain.frames }, (_, i) =>
            toSprite(buildSplashFrame(dpr, color, variant, (i + 0.5) / SETTLE.rain.frames)),
          ),
        );
      }
      // The colour may have changed (theme refresh) — repaint any settled snow with it.
      moundDirty = true;
    }
  }

  function spawn(p: Particle, initial: boolean): void {
    p.z = Math.random();
    p.vx = 0;
    p.vy = 0;
    p.phase = rand(0, Math.PI * 2);
    if (kind === 'snow') {
      const st = TUNING.snow;
      p.jitter = rand(st.speedJitter[0], st.speedJitter[1]);
      p.flutter = rand(st.flutterRate[0], st.flutterRate[1]);
      // A slice of the field goes to the deep background layers (depth < 0, tiny slow haze) and
      // a sparse slice to the foreground bokeh layer (depth > 1, big soft out-of-focus discs);
      // the rest keep the main-field depth. Same pattern as rain's deep layers.
      const sample = Math.random();
      if (sample < st.deepLayerFraction) {
        const layer = st.deepLayers[Math.random() < 0.5 ? 0 : 1];
        p.z = layer + rand(-st.deepLayerJitter, st.deepLayerJitter);
      } else if (sample > 1 - st.bokeh.fraction) {
        p.z = rand(st.bokeh.z[0], st.bokeh.z[1]);
      }
      if (p.z > 1) {
        p.variant = SNOW_BOKEH;
        p.spin = 0;
        p.flutterAmp = st.flutterAmp;
      } else if (p.z < st.grainMaxZ) {
        p.variant = SNOW_GRAIN;
        p.spin = 0;
        p.flutterAmp = st.flutterAmp * 0.8;
      } else {
        p.variant = Math.random() < 0.5 ? 1 : 2; // plain star or branched dendrite
        p.spin = rand(st.spin[0], st.spin[1]);
        // Branched dendrites flutter least: lacy shapes are the aerodynamically stable ones
        // (they stay steady well past the Reynolds numbers that set plain plates zigzagging).
        p.flutterAmp = st.flutterAmp * (p.variant === 2 ? 0.5 : 1);
      }
    } else {
      p.variant = Math.random() < 0.5 ? 0 : 1; // streak thickness
      p.spin = 0;
      p.jitter = 1;
      p.flutter = 0;
      p.flutterAmp = 0;
      // A slice of the field belongs to the two deep-background layers (depth < 0): pick one and
      // jitter its depth so its drops don't move in lockstep. The rest keep the main-field depth.
      const rt = TUNING.rain;
      if (Math.random() < rt.deepLayerFraction) {
        const layer = rt.deepLayers[Math.random() < 0.5 ? 0 : 1];
        p.z = layer + rand(-rt.deepLayerJitter, rt.deepLayerJitter);
      }
    }
    p.x = rand(-edgeMargin, cssWidth + edgeMargin);
    // On (re)spawn a particle starts just above the top; on the very first fill it is scattered
    // across the height so the field is already full at t=0 rather than raining in from nothing.
    p.y = initial ? rand(0, cssHeight) : -rand(vertMargin, vertMargin + cssHeight * 0.2);
  }

  /**
   * (Re)place one garnish piece above the top edge and give it a fresh glyph, depth and sway.
   * The `delay` is what makes the garnish occasional rather than a second snowfall: the piece
   * waits out that many seconds before it starts falling, so a pool of a handful of emoji still
   * only puts one or two on screen at a time.
   */
  function spawnGarnish(p: Garnish, initial: boolean): void {
    const gap = garnishOpts?.dense ? GARNISH.denseGap : GARNISH.gap;
    p.z = rand(GARNISH.z[0], GARNISH.z[1]);
    p.vx = 0;
    p.vy = 0;
    p.phase = rand(0, Math.PI * 2);
    p.spin = rand(GARNISH.sway[0], GARNISH.sway[1]);
    p.variant = Math.min(garnishSprites.length - 1, (Math.random() * garnishSprites.length) | 0);
    p.x = rand(-edgeMargin, cssWidth + edgeMargin);
    p.y = -rand(garnishMaxHalfH, garnishMaxHalfH + cssHeight * 0.15);
    // On the first fill the delays are spread across the whole gap range (rather than a full
    // wait each), so the garnish starts trickling in shortly after the layer appears instead of
    // leaving a suspiciously empty minute.
    p.delay = initial ? rand(0, gap[1]) : rand(gap[0], gap[1]);
  }

  function spawnVortex(v: Vortex, initial: boolean): void {
    v.r = rand(VORTEX.radius[0], VORTEX.radius[1]);
    v.r2 = v.r * v.r;
    const sign = Math.random() < 0.5 ? -1 : 1;
    v.peak = sign * rand(VORTEX.peak[0], VORTEX.peak[1]);
    v.x = rand(0, cssWidth);
    // Anywhere on screen, every generation: the lifecycle envelope spins strength up from zero,
    // so an eddy can appear mid-viewport without popping — and unlike a spawn-above-the-top
    // scheme, the short-lived eddies still cover the whole height, not just the top band.
    v.y = rand(0, cssHeight);
    // Each life starts after a hashed pause, so swirls are occasional events, not a constant
    // stir. The very first fill spreads the pauses across the range so eddies stagger in.
    v.delay = initial ? rand(0, VORTEX.gap[1]) : rand(VORTEX.gap[0], VORTEX.gap[1]);
    v.age = 0;
    v.life = rand(VORTEX.life[0], VORTEX.life[1]);
    v.strength = 0;
  }

  function resize(): void {
    const targetDpr = Math.min(typeof devicePixelRatio === 'number' ? devicePixelRatio : 1, dprCap);
    cssWidth = canvas.clientWidth || (typeof innerWidth === 'number' ? innerWidth : 0);
    cssHeight = canvas.clientHeight || (typeof innerHeight === 'number' ? innerHeight : 0);
    dpr = targetDpr;
    canvas.width = Math.max(1, Math.round(cssWidth * dpr));
    canvas.height = Math.max(1, Math.round(cssHeight * dpr));
    // Draw in CSS pixels; the backing store is the DPR-scaled size.
    ctx!.setTransform(dpr, 0, 0, dpr, 0, 0);
    buildSprites();

    const t = TUNING[kind];
    const area = Math.max(1, cssWidth * cssHeight);
    const base = Math.round(clamp(area / t.density, t.min, t.max));
    // The deep-background layers (both kinds) and snow's foreground bokeh layer are added on top
    // of the main count, so their spawn fractions never thin the main field.
    const extraFrac = t.deepLayerFraction + (kind === 'snow' ? TUNING.snow.bokeh.fraction : 0);
    const extras = Math.round((base * extraFrac) / (1 - extraFrac));
    // Snow reserves a dormant storm pool on top again — it costs nothing (neither stepped nor
    // drawn) until a blizzard fades it in, then the fall visibly thickens.
    const stormExtra = kind === 'snow' ? Math.round(base * TUNING.snow.storm.extra) : 0;
    // `suppressBase` runs the garnish on its own: no rain or snow behind it, so the pool is empty.
    const count = suppressBase ? 0 : base + extras + stormExtra;
    if (particles.length !== count) {
      particles = Array.from({ length: count }, (_, i) => ({
        x: 0,
        y: 0,
        z: 0,
        vx: 0,
        vy: 0,
        variant: 0,
        spin: 0,
        phase: 0,
        jitter: 1,
        flutter: 0,
        flutterAmp: 0,
        storm: i >= count - stormExtra,
      }));
      for (const p of particles) spawn(p, true);
    }

    if (garnishOpts) {
      const factor = garnishOpts.dense ? GARNISH.denseCountFactor : 1;
      const gCount = Math.round(clamp(area / GARNISH.density, GARNISH.min, GARNISH.max) * factor);
      if (garnishes.length !== gCount) {
        garnishes = Array.from({ length: gCount }, () => ({
          x: 0,
          y: 0,
          z: 0,
          vx: 0,
          vy: 0,
          variant: 0,
          spin: 0,
          phase: 0,
          jitter: 1,
          flutter: 0,
          flutterAmp: 0,
          storm: false,
          delay: 0,
        }));
        for (const g of garnishes) spawnGarnish(g, true);
      }
    }

    const vCount = Math.round(clamp(area / VORTEX.density, VORTEX.min, VORTEX.max));
    if (vortices.length !== vCount) {
      vortices = Array.from({ length: vCount }, () => ({
        x: 0,
        y: 0,
        r: 0,
        r2: 0,
        peak: 0,
        delay: 0,
        age: 0,
        life: 0,
        strength: 0,
      }));
      for (const v of vortices) spawnVortex(v, true);
    }

    if (interact && overlay) {
      overlay.width = canvas.width;
      overlay.height = canvas.height;
      // Setting width/height resets the context (and clears the bitmap), so re-apply the
      // transform after; the cleared bitmap means the overlay starts this size clean.
      octx!.setTransform(dpr, 0, 0, dpr, 0, 0);
      overlayClean = true;
      // The mound cache mirrors the overlay via the shared helper, so its DPR handling can
      // never drift from the sprites'.
      [moundCanvas, moundCtx] = makeCanvas(cssWidth, cssHeight, dpr);
      // A resize reflows everything: drop all settled snow and in-flight splashes, then
      // re-adopt the tracker's map. Its own resize-triggered rebuild follows within the
      // tracker's debounce window — the brief spell where landings test pre-reflow geometry is
      // self-healing (the rebuild's reconcile knocks any misplaced snow straight off).
      surfTops = new Int16Array(0);
      depths = new Float32Array(0);
      surfGen = -1;
      moundVisible = false;
      moundDirty = false;
      for (const s of splashes) s.t = s.life;
    }
  }

  /**
   * Adopt the tracker's latest surface map (issue #68). Columns whose top edge moved beyond the
   * tolerance lose their settled snow — the control moved (scroll, layout change), so its drift
   * is knocked off; columns whose surface is unchanged keep building. The tracker swaps in a
   * fresh array per rebuild (never mutates the published one), so holding the previous reference
   * is a stable comparison baseline and no copy is needed.
   */
  function reconcileSurfaces(snap: SurfaceSnapshot): void {
    const next = snap.tops;
    const prev = surfTops;
    if (depths.length !== next.length) depths = new Float32Array(next.length);
    for (let c = 0; c < next.length; c++) {
      const before = c < prev.length ? (prev[c] ?? NO_SURFACE) : NO_SURFACE;
      if (Math.abs((next[c] ?? NO_SURFACE) - before) > SETTLE.moveTolerance) depths[c] = 0;
    }
    surfTops = next;
    surfGen = snap.generation;
    // Splashes are absolutely positioned: one whose surface moved would hang mid-air, so expire
    // it (splashes on unmoved surfaces play out normally).
    for (const s of splashes) {
      if (s.t >= s.life) continue;
      const c = surfaceCol(s.x);
      if (c < 0 || Math.abs(topAt(c) - s.y) > SETTLE.moveTolerance) s.t = s.life;
    }
    // The layout moved: bypass the deposit throttle so surviving mounds re-render at their new
    // positions on the very next overlay pass, never lingering where controls used to be.
    moundDirty = true;
    lastMoundRender = -Infinity;
  }

  /** Column index of the surface map covering x, or -1 when outside it. */
  function surfaceCol(x: number): number {
    // floor, not |0: truncation would map the off-screen wrap margin x ∈ (-COLUMN_WIDTH, 0)
    // onto column 0 and let unseen particles land on the leftmost control.
    const c = Math.floor(x / COLUMN_WIDTH);
    return c >= 0 && c < surfTops.length ? c : -1;
  }

  /** Guarded column reads (indexes are always produced in-range, so the fallbacks are inert). */
  function topAt(c: number): number {
    return surfTops[c] ?? NO_SURFACE;
  }
  function depthAt(c: number): number {
    return depths[c] ?? 0;
  }

  /**
   * What one neighbouring column says about how steep the surface is here, in rise/run:
   *  - a step within {@link SNOW_JOIN_STEP} is the same drift surface → its actual gradient;
   *  - a step in the flank band (≤ {@link SNOW_CLIFF_STEP}) is a steep face of this surface →
   *    the repose cutoff (snow sheds);
   *  - anything larger is a different control entirely (a cliff), and a rooftop edge beside a
   *    cliff is still flat ground — the neighbour offers **no evidence** (-1).
   */
  function sideSlopeEvidence(here: number, neighbour: number): number {
    if (neighbour === NO_SURFACE) return -1;
    const step = Math.abs(here - neighbour);
    if (step <= SNOW_JOIN_STEP) return step / COLUMN_WIDTH;
    if (step <= SNOW_CLIFF_STEP) return SETTLE.snow.slopeMax;
    return -1;
  }

  /**
   * How well a column holds settling snow (0 = sheds everything, 1 = flat ground), from the
   * angle-of-repose falloff over the local slope. Slope is judged from whichever neighbours
   * offer evidence, taking the *gentler* side — snow rests wherever it is supported from at
   * least one side, so a rooftop edge or the last column before a cliff still piles up while a
   * mid-arc flank (steep on both sides) sheds.
   */
  function holdAt(c: number): number {
    const here = topAt(c);
    if (here === NO_SURFACE) return 0;
    const left = sideSlopeEvidence(here, c > 0 ? topAt(c - 1) : NO_SURFACE);
    const right = sideSlopeEvidence(here, c + 1 < surfTops.length ? topAt(c + 1) : NO_SURFACE);
    let slope = 0;
    if (left >= 0 && right >= 0) slope = Math.min(left, right);
    else if (left >= 0) slope = left;
    else if (right >= 0) slope = right;
    return clamp(1 - slope / SETTLE.snow.slopeMax, 0, 1);
  }

  /**
   * Grow the settled-snow field around a landing column. The kernel spreads the deposit over
   * neighbouring columns, but only while they stay on the same drift surface (per-distance
   * {@link SNOW_JOIN_STEP} allowance, so a corner arc's descent is included and the gap between
   * two controls never is), and each column takes its own {@link holdAt} share — a sloped
   * shoulder receives a tapered spread even when the flake struck the flat top beside it. Once a
   * mound has saturated at the depth cap, further landings change nothing and must not keep
   * re-dirtying the render cache.
   *
   * Returns whether the surface held the snow at all — false on a too-steep face, so the caller
   * lets the flake slide off and keep falling instead of consuming it.
   */
  function depositSnow(col: number, top: number): boolean {
    const t = SETTLE.snow;
    if (holdAt(col) <= 0) return false;
    const reach = t.kernel.length - 1;
    let changed = false;
    for (let o = -reach; o <= reach; o++) {
      const c = col + o;
      if (c < 0 || c >= surfTops.length) continue;
      if (Math.abs(topAt(c) - top) > SNOW_JOIN_STEP * Math.max(1, Math.abs(o))) continue;
      const hold = holdAt(c);
      if (hold <= 0) continue;
      const d = depthAt(c) + t.deposit * hold * (t.kernel[Math.abs(o)] ?? 0);
      const capped = d > t.maxDepth ? t.maxDepth : d;
      if (capped !== depthAt(c)) {
        depths[c] = capped;
        changed = true;
      }
    }
    if (changed) moundDirty = true;
    return true;
  }

  /**
   * Land a near particle whose fall just crossed the surface line in its column: snow settles
   * onto the current crest (the mound grows under it); rain is consumed by a splash at the top
   * edge. Far particles pass behind the UI untouched — depth is the eligibility gate.
   */
  function tryLand(p: Particle, prevY: number): void {
    // Depth gates both ways: far particles pass *behind* the UI, and the foreground bokeh layer
    // (depth > 1) floats *in front* of it — only the main field's near band interacts.
    if (p.z < SETTLE[kind].minZ || p.z > 1) return;
    const c = surfaceCol(p.x);
    if (c < 0) return;
    const top = topAt(c);
    if (top === NO_SURFACE) return;
    const line = kind === 'snow' ? top - depthAt(c) : top;
    if (prevY >= line || p.y < line) return;
    if (kind === 'snow') {
      // A too-steep face (a corner's flank) doesn't hold snow — the flake slides off and falls on.
      if (!depositSnow(c, top)) return;
    } else {
      spawnSplash(p.x, top, p.z);
    }
    spawn(p, false);
  }

  /** Start a splash at a free pool slot (skipped when the pool is saturated — it's decorative). */
  function spawnSplash(x: number, y: number, z: number): void {
    for (const s of splashes) {
      if (s.t < s.life) continue;
      s.x = x;
      s.y = y;
      s.t = 0;
      s.life = rand(SETTLE.rain.life[0], SETTLE.rain.life[1]);
      s.scale = lerp(SETTLE.rain.scale[0], SETTLE.rain.scale[1], clamp(z, 0, 1));
      s.variant = Math.random() < 0.5 ? 0 : 1;
      return;
    }
  }

  /**
   * Re-render the mound layer into its offscreen cache. This is the only place the interaction
   * layer builds paths, and it runs at most every {@link SETTLE.snow.renderInterval} seconds and
   * only when something changed; every frame in between reuses the cache with a single blit.
   */
  function renderMounds(): void {
    moundDirty = false;
    lastMoundRender = elapsed;
    moundVisible = false;
    moundCtx?.clearRect(0, 0, cssWidth, cssHeight);
    const t = SETTLE.snow;
    const n = surfTops.length;
    let c = 0;
    while (c < n) {
      if (topAt(c) === NO_SURFACE || depthAt(c) < t.minVisibleDepth) {
        c++;
        continue;
      }
      // Extend the run while the surface stays continuous (same-drift steps, so a corner arc's
      // descent belongs to its control's run) and holds visible snow.
      let end = c;
      while (
        end + 1 < n &&
        topAt(end + 1) !== NO_SURFACE &&
        depthAt(end + 1) >= t.minVisibleDepth &&
        Math.abs(topAt(end + 1) - topAt(end)) <= SNOW_JOIN_STEP
      ) {
        end++;
      }
      moundVisible = true;
      if (moundCtx) drawMoundRun(c, end);
      c = end + 1;
    }
  }

  /** x of a column's crest point (its centre). */
  function crestX(c: number): number {
    return c * COLUMN_WIDTH + COLUMN_WIDTH / 2;
  }

  /** y of a column's crest (its surface top minus the settled depth). */
  function crestY(c: number): number {
    return topAt(c) - depthAt(c);
  }

  /** Trace the midpoint-smoothed crest polyline for a run into the current path. */
  function traceCrest(g: CanvasRenderingContext2D, c0: number, c1: number): void {
    g.moveTo(crestX(c0), crestY(c0));
    for (let c = c0 + 1; c <= c1; c++) {
      const mx = (crestX(c - 1) + crestX(c)) / 2;
      const my = (crestY(c - 1) + crestY(c)) / 2;
      g.quadraticCurveTo(crestX(c - 1), crestY(c - 1), mx, my);
    }
    g.lineTo(crestX(c1), crestY(c1));
  }

  /** √-eased 0..1 ramp of a column's depth toward the cap (thin snow brightens fast, then eases). */
  function depthRamp(c: number): number {
    return Math.sqrt(clamp(depthAt(c) / SETTLE.snow.maxDepth, 0, 1));
  }

  /** Quantised {@link depthRamp}, so visually-identical alphas compare equal for stop dedup. */
  function quantRamp(c: number): number {
    return Math.round(depthRamp(c) * 24) / 24;
  }

  /**
   * Build the fill and crest paints for one run in a single column sweep. Alpha tracks each
   * column's depth — thin fresh snow is translucent and a drift only turns properly opaque as
   * it deepens — but stops are emitted only where the quantised ramp *changes*, so a uniform or
   * saturated run collapses to its two end stops instead of one stop (and one `color-mix`
   * parse) per column. Built at mound-render time (a few times/s at most), never per frame.
   */
  function buildRunPaints(
    c0: number,
    c1: number,
  ): { fill: string | CanvasGradient; crest: string | CanvasGradient } {
    const t = SETTLE.snow;
    if (c1 === c0) {
      const ramp = depthRamp(c0);
      return {
        fill: colorWithAlpha(overlayColor, lerp(t.alpha[0], t.alpha[1], ramp)),
        crest: colorWithAlpha(overlayColor, lerp(t.crestAlpha[0], t.crestAlpha[1], ramp)),
      };
    }
    const g = moundCtx!;
    const x0 = crestX(c0);
    const x1 = crestX(c1);
    const fill = g.createLinearGradient(x0, 0, x1, 0);
    const crest = g.createLinearGradient(x0, 0, x1, 0);
    const addStops = (c: number, ramp: number): void => {
      const offset = (crestX(c) - x0) / (x1 - x0);
      fill.addColorStop(offset, colorWithAlpha(overlayColor, lerp(t.alpha[0], t.alpha[1], ramp)));
      crest.addColorStop(offset, colorWithAlpha(overlayColor, lerp(t.crestAlpha[0], t.crestAlpha[1], ramp)));
    };
    let prev = quantRamp(c0);
    let plateauStart = c0;
    addStops(c0, prev);
    for (let c = c0 + 1; c <= c1; c++) {
      const q = quantRamp(c);
      if (q !== prev) {
        // Close the plateau at its far edge so the gradient holds flat across it, then step.
        if (plateauStart < c - 1) addStops(c - 1, prev);
        addStops(c, q);
        prev = q;
        plateauStart = c;
      } else if (c === c1) {
        addStops(c, q);
      }
    }
    return { fill, crest };
  }

  /** Fill one contiguous mound: a smoothed crest over the run, tapering to the surface at both ends. */
  function drawMoundRun(c0: number, c1: number): void {
    const g = moundCtx!;
    // The fill returns along the per-column surface tops rather than a straight chord — a run
    // may ramp within the edge tolerance, and the base must hug each control's actual edge.
    g.beginPath();
    traceCrest(g, c0, c1);
    g.lineTo((c1 + 1) * COLUMN_WIDTH, topAt(c1));
    for (let c = c1; c >= c0; c--) g.lineTo(crestX(c), topAt(c));
    g.lineTo(c0 * COLUMN_WIDTH, topAt(c0));
    g.closePath();
    const paints = buildRunPaints(c0, c1);
    g.fillStyle = paints.fill;
    g.fill();
    // A soft cap along the crest gives the drift a lit top edge, fading in with depth like the
    // fill. Stroked as its own open path — stroking the closed fill outline would also draw a
    // hard line along the control's top edge.
    g.beginPath();
    if (c1 === c0) {
      // A zero-length path draws nothing under butt caps; give a lone column its short cap.
      g.moveTo(c0 * COLUMN_WIDTH, crestY(c0));
      g.lineTo((c0 + 1) * COLUMN_WIDTH, crestY(c0));
    } else {
      traceCrest(g, c0, c1);
    }
    g.strokeStyle = paints.crest;
    g.lineWidth = 1;
    g.lineJoin = 'round';
    g.stroke();
  }

  /** Is any splash still animating? (Plain loop — runs every frame, must not allocate.) */
  function anySplashActive(): boolean {
    for (const s of splashes) if (s.t < s.life) return true;
    return false;
  }

  /** Advance and blit the active splashes (alpha is baked into the frames). */
  function drawSplashes(dt: number): void {
    for (const s of splashes) {
      if (s.t >= s.life) continue;
      s.t += dt;
      if (s.t >= s.life) continue;
      const set = splashFrames[s.variant];
      if (!set) continue;
      const q = s.t / s.life;
      const f = set[Math.min(set.length - 1, (q * set.length) | 0)];
      if (!f) continue;
      const w = f.halfW * 2 * s.scale;
      const h = f.halfH * 2 * s.scale;
      octx!.drawImage(f.canvas, s.x - w / 2, s.y - SPLASH_BASELINE * s.scale, w, h);
    }
  }

  /** Blit a horizontal css-x span [x0, x1) of the mound cache to the overlay, offset by `dy`. */
  function blitMoundSpan(x0: number, x1: number, dy: number): void {
    if (x1 <= x0 || !moundCanvas) return;
    // Cache backing store is DPR-scaled; map css → source x by the exact ratio (full source height).
    const sx = moundCanvas.width / cssWidth;
    octx!.drawImage(moundCanvas, x0 * sx, 0, (x1 - x0) * sx, moundCanvas.height, x0, dy, x1 - x0, cssHeight);
  }

  /**
   * Blit the cached mound layer, riding the hover lift of whichever control the pointer is over
   * (issue #68 follow-up): the columns that control spans are drawn shifted by its live transform
   * offset, the rest at rest — so a card's settled snow lifts and eases back with the card instead
   * of hanging in mid-air. The map itself stays at the resting position (see {@link
   * import('./surface-map').HoverFollow}), so this is the only place the lift is applied.
   */
  function blitMounds(): void {
    const h = interact ? surfaces!.hoverFollow() : null;
    const dy = h ? clamp(h.dy, -32, 32) : 0;
    if (!h || Math.abs(dy) < 0.5) {
      octx!.drawImage(moundCanvas!, 0, 0, cssWidth, cssHeight);
      return;
    }
    const x0 = clamp(h.c0 * COLUMN_WIDTH, 0, cssWidth);
    const x1 = clamp((h.c1 + 1) * COLUMN_WIDTH, 0, cssWidth);
    blitMoundSpan(0, x0, 0);
    blitMoundSpan(x0, x1, dy);
    blitMoundSpan(x1, cssWidth, 0);
  }

  /** Paint the interaction overlay: the cached mound layer plus any in-flight splashes. */
  function drawOverlay(dt: number): void {
    if (moundDirty && elapsed - lastMoundRender >= SETTLE.snow.renderInterval) renderMounds();
    const hasMound = moundVisible && moundCanvas !== null;
    if (!hasMound && !anySplashActive()) {
      // Nothing to draw: clear once after the last visible frame, then skip the whole pass.
      // (While snow is settled, `hasMound` keeps the overlay live every frame, so an in-progress
      // hover lift is followed continuously by blitMounds rather than snapping.)
      if (!overlayClean) {
        octx!.clearRect(0, 0, cssWidth, cssHeight);
        overlayClean = true;
      }
      return;
    }
    octx!.clearRect(0, 0, cssWidth, cssHeight);
    overlayClean = false;
    if (hasMound) blitMounds();
    drawSplashes(dt);
    octx!.globalAlpha = 1;
  }

  /** Add every active eddy's tangential swirl to the particle's already-set velocity. */
  function addVortices(p: Particle, factor: number): void {
    for (const v of vortices) {
      if (v.strength <= 0) continue;
      const dx = p.x - v.x;
      const dy = p.y - v.y;
      const r2 = dx * dx + dy * dy;
      if (r2 >= v.r2) continue;
      const r = Math.sqrt(r2);
      if (r < 0.01) continue;
      // Rankine vortex: solid-body rotation inside the core (zero at the calm eye, peak at the
      // core edge), a 1/r potential tail outside, tapered to zero at the rim so the eddy splices
      // into the ambient flow. The core cap is what makes a swirl read as a swirl — a coreless
      // 1/r profile has a singular centre and smears instead.
      const norm = r / v.r;
      const profile =
        norm < VORTEX.core ? norm / VORTEX.core : (VORTEX.core / norm) * ((1 - norm) / (1 - VORTEX.core));
      const vt = v.peak * profile * v.strength * factor;
      p.vx += (-dy / r) * vt;
      p.vy += (dx / r) * vt;
    }
  }

  function advanceVortices(dt: number): void {
    for (const v of vortices) {
      // A waiting eddy sits out its pause invisibly, then spins up where it was placed.
      if (v.delay > 0) {
        v.delay -= dt;
        v.strength = 0;
        continue;
      }
      v.age += dt;
      if (v.age >= v.life) {
        spawnVortex(v, false);
        continue;
      }
      // Lifecycle envelope (spin-up → peak → spin-down), then the weather's say: a blizzard's
      // straight wind shreds coherent eddies, while a dead-calm spell (no flurry) amplifies
      // them — the calm-air swirl the eye actually notices.
      const env = smooth01(Math.min(v.age, v.life - v.age) / VORTEX.ramp);
      v.strength = env * (1 - VORTEX.stormDamp * frameStorm) * (1 + VORTEX.calmBoost * (1 - frameFlurry));
      // Eddies are carried along by the wind and sink slowly, then recycle off the bottom.
      v.x += frameGust * VORTEX.drift * dt;
      v.y += VORTEX.sink * dt;
      if (v.x < -v.r) v.x += cssWidth + 2 * v.r;
      else if (v.x > cssWidth + v.r) v.x -= cssWidth + 2 * v.r;
      if (v.y - v.r > cssHeight) spawnVortex(v, false);
    }
  }

  function stepRain(p: Particle, dt: number): void {
    const t = TUNING.rain;
    // Far layers fall a fraction of the foreground fallSpeed; depth lerps between them (deep layers,
    // depth < 0, extrapolate slower still). All of it scales with the single {@link fallSpeed} knob.
    const fall = lerp(t.fallSpeed * t.depthSpeedRatio, t.fallSpeed, p.z);
    const lean = t.baseLean + frameGust * t.gustLean * (0.6 + frameFlurry * 0.7);
    const c = curlField(p.x, p.y, elapsed);
    p.vx = fall * lean + c.x * t.turb * p.z;
    p.vy = fall;
    addVortices(p, t.vortexFactor);
    const prevY = p.y;
    p.x += p.vx * dt;
    p.y += p.vy * dt;
    if (interact) tryLand(p, prevY);
  }

  function stepSnow(p: Particle, dt: number): void {
    const t = TUNING.snow;
    const depth = 0.45 + p.z; // nearer flakes catch more wind (deep layers less, bokeh more)
    // Flutter: the zigzag side-slip of vortex shedding. One sine drives both the sideways swing
    // and the coupled fall-speed dip at the swing extremes (a swinging flake visibly hesitates).
    const swing = Math.sin(elapsed * p.flutter + p.phase * 1.7);
    const fall =
      lerp(t.speed[0], t.speed[1], p.z) *
      p.jitter *
      (1 + frameStorm * t.storm.fallBoost) *
      (1 - t.flutterFallPulse * swing * swing);
    const c = curlField(p.x, p.y, elapsed);
    // Preferential sweeping: downdraft-side turbulence settles flakes harder than updrafts lift.
    const sweepY = c.y > 0 ? 1 + t.sweep : 1;
    p.vx =
      frameGust * t.wind * (0.5 + frameFlurry) * depth +
      framePulse * t.pulseWind * depth +
      frameStormWind * t.storm.wind * depth +
      c.x * t.turb * depth +
      swing * p.flutterAmp * (0.35 + 0.65 * clamp(p.z, 0, 1));
    p.vy = fall + c.y * t.turb * 0.5 * depth * sweepY;
    addVortices(p, t.vortexFactor);
    // Never let a flake fly purely sideways in calm air; a blizzard relaxes the cap so the
    // field can rake near-horizontal, and it tightens back as the storm dies.
    const driftCap = fall * t.maxDriftRatio * (1 + frameStorm * t.storm.driftBoost);
    p.vx = clamp(p.vx, -driftCap, driftCap);
    const prevY = p.y;
    p.x += p.vx * dt;
    p.y += p.vy * dt;
    if (interact) tryLand(p, prevY);
  }

  /**
   * Advance one garnish piece. It rides the same wind and curl field as the snow — so it belongs
   * to the scene rather than falling on its own track — but slower and with a gentler response,
   * as a big light object should. It deliberately does **not** interact with control surfaces:
   * a present settling into a snowdrift would be a different feature, and skipping the surface
   * lookup keeps the garnish free.
   */
  function stepGarnish(p: Garnish, dt: number): void {
    if (p.delay > 0) {
      p.delay -= dt;
      return;
    }
    const fall = lerp(GARNISH.speed[0], GARNISH.speed[1], p.z);
    const c = curlField(p.x, p.y, elapsed);
    p.vx = frameGust * GARNISH.wind * (0.5 + frameFlurry) * p.z + c.x * GARNISH.turb * p.z;
    p.vy = fall + c.y * GARNISH.turb * 0.4 * p.z;
    p.x += p.vx * dt;
    p.y += p.vy * dt;
    if (p.x < -edgeMargin) p.x += cssWidth + 2 * edgeMargin;
    else if (p.x > cssWidth + edgeMargin) p.x -= cssWidth + 2 * edgeMargin;
    if (p.y - garnishMaxHalfH > cssHeight) spawnGarnish(p, false);
  }

  /** Blit one garnish piece, rocking gently around its centre. Waiting pieces draw nothing. */
  function drawGarnish(p: Garnish): void {
    if (p.delay > 0) return;
    const s = garnishSprites[p.variant];
    if (!s) return;
    const scale = lerp(GARNISH.scale[0], GARNISH.scale[1], p.z);
    const w = s.halfW * 2 * scale;
    const h = s.halfH * 2 * scale;
    ctx!.save();
    ctx!.translate(p.x, p.y);
    ctx!.rotate(Math.sin(elapsed * p.spin + p.phase) * GARNISH.tilt);
    ctx!.globalAlpha = lerp(GARNISH.alpha[0], GARNISH.alpha[1], p.z);
    ctx!.drawImage(s.canvas, -w / 2, -h / 2, w, h);
    ctx!.restore();
  }

  /** Wrap the particle horizontally (wind blows either way) and recycle it once past the bottom. */
  function wrapAndRecycle(p: Particle): void {
    if (p.x < -edgeMargin) p.x += cssWidth + 2 * edgeMargin;
    else if (p.x > cssWidth + edgeMargin) p.x -= cssWidth + 2 * edgeMargin;
    if (p.y - vertMargin > cssHeight) spawn(p, false);
  }

  function drawRain(p: Particle): void {
    const s = sprites[p.variant];
    if (!s) return;
    const t = TUNING.rain;
    const scale = lerp(t.scale[0], t.scale[1], p.z);
    // Base length is depth-scaled (near = longer); the wind then elongates it by the drop's lean
    // (|vx| / vy) — a depth-independent factor, so it never cancels the depth→speed parallax. p.vy
    // is the pure fall speed for rain (no vertical turbulence is added), so it's the lean baseline.
    const lean = p.vy > 0 ? Math.abs(p.vx) / p.vy : 0;
    const stretch = clamp(1 + lean * t.windStretchGain, 1, t.windStretchMax);
    const w = s.halfW * 2 * scale;
    const h = s.halfH * 2 * scale * stretch;
    // Rotate the vertical sprite so its downward axis aligns with the drop's velocity.
    const angle = Math.atan2(-p.vx, p.vy);
    // Deep-background layers (depth < 0) get an opacity lift so they don't fade to invisible; the
    // main field keeps its plain depth-driven alpha.
    const alpha = lerp(t.alpha[0], t.alpha[1], p.z) + (p.z < 0 ? t.deepAlphaBoost : 0);
    ctx!.save();
    ctx!.translate(p.x, p.y);
    ctx!.rotate(angle);
    ctx!.globalAlpha = alpha;
    ctx!.drawImage(s.canvas, -w / 2, -h / 2, w, h);
    ctx!.restore();
  }

  function drawSnow(p: Particle): void {
    const s = sprites[p.variant];
    if (!s) return;
    const t = TUNING.snow;
    // Depth-extrapolated like rain: deep layers (z < 0) shrink below scale[0], bokeh (z > 1)
    // grows past scale[1] — the widened parallax range.
    const scale = lerp(t.scale[0], t.scale[1], p.z);
    const w = s.halfW * 2 * scale;
    const h = s.halfH * 2 * scale;
    let alpha: number;
    if (p.variant === SNOW_BOKEH) {
      // The bokeh disc fades *further* the closer it sits to the viewer — more defocus, dimmer —
      // and doesn't twinkle (an out-of-focus blob has no glinting facets).
      const q = (p.z - t.bokeh.z[0]) / (t.bokeh.z[1] - t.bokeh.z[0]);
      alpha = lerp(t.bokeh.alpha[0], t.bokeh.alpha[1], clamp(q, 0, 1));
    } else {
      // A flurry lifts the whole field's opacity a touch (surges read as "thicker"); a faint
      // per-flake twinkle keeps close crystals from looking static; the deep background layers
      // get the same alpha lift as rain's so extrapolation never fades them to nothing.
      const twinkle = 1 - t.twinkleAmp * (0.5 + 0.5 * Math.sin(elapsed * t.twinkleSpeed + p.phase));
      alpha =
        (lerp(t.alpha[0], t.alpha[1], p.z) + (p.z < 0 ? t.deepAlphaBoost : 0)) *
        (0.85 + frameFlurry * 0.15) *
        twinkle;
    }
    // Storm-pool flakes ride the blizzard envelope, so the thickening fades in and out with it.
    if (p.storm) alpha *= frameStorm;
    let stretch = 1;
    if (frameStorm > 0.02) {
      const st = t.storm;
      // Density "curtains": a slow spatial wave sweeping with the storm wind modulates local
      // opacity, so the blizzard arrives in turbulent sheets rather than a uniform wall.
      const wave = Math.sin(
        (p.x * Math.PI * 2) / st.waveLength -
          elapsed * st.waveSpeed * (frameStormWind < 0 ? -1 : 1) +
          p.z * 2,
      );
      alpha *= 1 + frameStorm * st.waveAmp * wave;
      // Motion streaks: wind-raked flakes elongate along their velocity (shutter blur — the
      // photoreal cheat), scaling with how hard the storm has them leaning.
      const lean = p.vy > 1 ? Math.abs(p.vx) / p.vy : 0;
      stretch = clamp(1 + frameStorm * st.streakGain * lean, 1, st.streakMax);
    }
    // The streak path engages while the sprite is still essentially unstretched (≈2%), so the
    // handoff is length-continuous and the rotation change is imperceptible on these (near-)
    // symmetric sprites — no pop, and no flicker when flutter wobbles a flake across the line.
    ctx!.globalAlpha = clamp(alpha, 0, 1);
    if (stretch > 1.02) {
      // Streaked: align the sprite with the velocity and elongate it. (Any spin is irrelevant
      // once a flake is drawn as a streak.)
      ctx!.save();
      ctx!.translate(p.x, p.y);
      ctx!.rotate(Math.atan2(-p.vx, p.vy));
      ctx!.drawImage(s.canvas, -w / 2, (-h * stretch) / 2, w, h * stretch);
      ctx!.restore();
      return;
    }
    if (p.variant === SNOW_GRAIN || p.variant === SNOW_BOKEH) {
      // Grains and bokeh discs are angularly symmetric — a plain blit, the cheapest path.
      ctx!.drawImage(s.canvas, p.x - w / 2, p.y - h / 2, w, h);
      return;
    }
    // Crystals rotate slowly around their centre.
    ctx!.save();
    ctx!.translate(p.x, p.y);
    ctx!.rotate(elapsed * p.spin + p.phase);
    ctx!.drawImage(s.canvas, -w / 2, -h / 2, w, h);
    ctx!.restore();
  }

  function paint(animate: boolean, dt: number): void {
    ctx!.clearRect(0, 0, cssWidth, cssHeight);
    if (animate) {
      frameGust = gust(elapsed);
      frameFlurry = flurry(elapsed);
      if (kind === 'snow') {
        frameStorm = blizzard(elapsed);
        frameStormWind = blizzardWind(elapsed);
        framePulse = gustPulse(elapsed);
        // A blizzard is at least as intense as a full flurry: folding the storm envelope into
        // the flurry channel lifts the field's opacity and gust response with it for free.
        frameFlurry = Math.max(frameFlurry, frameStorm);
      }
      advanceVortices(dt);
      if (interact) {
        // Adopt the surface map *before* the particle step, so landings test current geometry.
        const snap = surfaces!.snapshot();
        if (snap.generation !== surfGen) reconcileSurfaces(snap);
      }
    }
    // (`frameStorm` stays 0 on a static reduced-motion frame, so the calm scene has no haze.)
    const stormActive = frameStorm > 0.02;
    if (stormActive && hazeSprite) {
      // The whiteout veil, behind the flakes: one stretched blit of the cached gradient strip,
      // its opacity riding the storm envelope.
      ctx!.globalAlpha = frameStorm * TUNING.snow.storm.hazeAlpha;
      ctx!.drawImage(hazeSprite.canvas, 0, 0, cssWidth, cssHeight);
      ctx!.globalAlpha = 1;
    }
    if (kind === 'rain') {
      for (const p of particles) {
        if (animate) {
          stepRain(p, dt);
          wrapAndRecycle(p);
        }
        drawRain(p);
      }
    } else {
      for (const p of particles) {
        // The reserve storm pool is dormant in calm weather: not stepped, not drawn, no cost.
        // Where a flake froze when the last storm faded is where the next one wakes it.
        if (p.storm && !stormActive) continue;
        if (animate) {
          stepSnow(p, dt);
          wrapAndRecycle(p);
        }
        drawSnow(p);
      }
    }
    // The garnish draws last, in front of the field it rides: it is the thing meant to be noticed,
    // and a present half-hidden behind a snow flurry reads as a rendering glitch rather than a
    // surprise. (Under `reduced` there is no garnish at all, so this is skipped with the loop.)
    for (const g of garnishes) {
      if (animate) stepGarnish(g, dt);
      drawGarnish(g);
    }
    ctx!.globalAlpha = 1;
    if (interact && animate) drawOverlay(dt);
  }

  function frame(now: number): void {
    if (stopped) return;
    const dt = lastTime ? Math.min((now - lastTime) / 1000, MAX_STEP) : 0;
    lastTime = now;
    elapsed += dt;
    paint(true, dt);
    rafId = requestAnimationFrame(frame);
  }

  function loop(): void {
    if (stopped || reduced) return;
    cancelAnimationFrame(rafId);
    lastTime = 0;
    rafId = requestAnimationFrame(frame);
  }

  function onVisibility(): void {
    if (reduced) return;
    if (document.hidden) {
      cancelAnimationFrame(rafId);
      rafId = 0;
    } else if (!rafId) {
      loop();
    }
  }

  function onResize(): void {
    if (resizeQueued || stopped) return;
    resizeQueued = true;
    requestAnimationFrame(() => {
      resizeQueued = false;
      if (stopped) return;
      resize();
      if (reduced) paint(false, 0);
    });
  }

  // ── Start ────────────────────────────────────────────────────────────────────────────────
  resize();
  if (reduced) {
    // Reduced motion: one calm static frame, no loop (a canvas isn't reached by the CSS
    // reduced-motion catch-all, so the gate is enforced here).
    paint(false, 0);
  } else {
    loop();
    document.addEventListener('visibilitychange', onVisibility);
  }
  addEventListener('resize', onResize);

  return {
    refresh() {
      if (stopped) return;
      buildSprites();
      if (reduced) paint(false, 0);
    },
    stop() {
      stopped = true;
      cancelAnimationFrame(rafId);
      removeEventListener('resize', onResize);
      document.removeEventListener('visibilitychange', onVisibility);
      surfaces?.stop();
    },
  };
}
