/**
 * flow-field — the pure, dependency-free "wind" maths behind the animated weather layer.
 *
 * Split out from {@link import('./precip-engine').startPrecip} so the interesting bit — the motion,
 * not the canvas plumbing — is unit-testable in isolation (a 2D context is unavailable under the
 * test DOM, so the engine itself can only be smoke-tested). Everything here is a small, allocation-
 * free pure function of `(position?, time)`, cheap enough to evaluate per-particle per-frame on the
 * CPU while the actual pixels are composited on the GPU by the engine.
 *
 * Grounding: natural falling snow/rain is not a uniform drift — it is a *turbulent wind field*.
 * The established real-time recipe (Perlin/curl-noise-driven particle advection; see the snow-scene
 * and GPU-rain literature) is reproduced here with cheap, closed-form substitutes:
 *
 *  - {@link gust} — a slowly-evolving global wind that eases in and out (layered low-frequency
 *    sines ≈ 1-D value noise), so the whole field leans and un-leans together like real gusts.
 *  - {@link flurry} — an intensity envelope with long calm stretches and occasional surges, so the
 *    weather "picks up" and settles rather than raining/snowing at a constant rate.
 *  - {@link curlField} — a divergence-free turbulence field (the analytic curl of a scalar
 *    potential). Being divergence-free means particles swirl through it without piling up or
 *    thinning out, which reads as natural eddies and small vortices — the organic swirl the plain
 *    old sine-sway never had.
 *  - {@link gustPulse} — occasional *discrete* gusts layered over the smooth {@link gust} wander.
 *    Real gusts are events, not oscillations: a sharp onset over a second or two, then a longer
 *    die-away (the classic asymmetric gust envelope from the wind-engineering literature, cheaply
 *    approximated here with smoothstep ramps). Each pulse carries its own hashed direction and
 *    strength, so the field is shoved — briefly, decisively — rather than only swaying.
 *  - {@link blizzard} / {@link blizzardWind} — a storm scheduler. Time is cut into epochs and a
 *    deterministic hash decides which epochs carry a blizzard, when in the epoch it starts, how
 *    long it blows and which way. The envelope rises over several seconds, holds, and decays more
 *    slowly — the shape of a real squall passing through — and the whole schedule is a pure
 *    function of time, so "occasional random storms" stay reproducible and unit-testable.
 *  - {@link squall} / {@link diamondDust} / {@link graupelShower} / {@link warmSnow} /
 *    {@link deadAir} — further snow events on the same epoch-hash machinery ({@link spell}),
 *    each with its own cadence and envelope shape: the squall's near-instant slam-and-clear,
 *    diamond dust's slow shimmer-in of a clear-sky crystal haze, the graupel shower's brief
 *    rattle of dense pellets, warm-snow's spells of big lazy aggregate clumps, and dead-air's
 *    windless laminar lulls.
 *  - {@link lightningFlash} — thundersnow. Deliberately *not* smooth: real lightning rises in
 *    under a millisecond, so the flash steps on instantly and flickers through two or three
 *    decaying strokes. The engine gates it behind a deep blizzard, where thundersnow lives.
 *
 * None of this touches the DOM, so it is safe to import anywhere and trivial to test.
 */

/** A 2-D vector. */
export interface Vec2 {
  x: number;
  y: number;
}

/**
 * The single scratch vector {@link curlField} writes into and returns. Reused so the hot path —
 * one call per particle per frame, several hundred per frame during a blizzard — allocates
 * nothing; callers read the components before the next call (which every caller does).
 */
const CURL_SCRATCH: Vec2 = { x: 0, y: 0 };

/**
 * Slowly-evolving global wind in roughly [-1, 1]. Three low-frequency sines at incommensurate
 * rates approximate 1-D value noise: the sum wanders smoothly and never repeats on a human
 * timescale, so the field gusts one way, eases, then leans the other — no abrupt jumps. `seed`
 * decorrelates independent channels (e.g. a second gust axis) from the same clock.
 */
export function gust(t: number, seed = 0): number {
  const v =
    Math.sin(t * 0.23 + seed) * 0.6 +
    Math.sin(t * 0.57 + seed * 1.7 + 0.9) * 0.3 +
    Math.sin(t * 1.13 + seed * 2.9 + 2.1) * 0.1;
  // The amplitudes sum to 1, but the sines rarely peak together; clamp guards the rare alignment.
  return v < -1 ? -1 : v > 1 ? 1 : v;
}

/**
 * Weather intensity envelope in [0, 1]: mostly gentle, with occasional surges ("flurries"). A slow
 * base swell sets the mood; a cubed peak term stays near zero most of the time and spikes toward 1
 * only when its sine crests, giving long calm passages punctuated by bursts rather than a constant
 * rate. Drives how hard the wind pushes and how the field is spawned/faded in the engine.
 */
export function flurry(t: number): number {
  const base = Math.sin(t * 0.15 + 0.4) * 0.5 + 0.5; // 0..1, slow swell
  const crest = Math.sin(t * 0.09 + 1.3) * 0.5 + 0.5; // 0..1
  const surge = crest * crest * crest; // sharp, brief peaks
  const v = base * 0.45 + surge * 0.7;
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/** Eddy size in CSS px — the characteristic scale of the turbulence swirls. */
const EDDY_SCALE = 170;
/** Finite-difference step (in normalised noise space) used to take the curl. */
const CURL_EPS = 0.15;

/**
 * Scalar stream-function whose curl we take. Two summed sine×cosine lobes drifting at different
 * rates give an evolving, non-repeating potential; its gradient (below) is the turbulent flow.
 */
function potential(nx: number, ny: number, t: number): number {
  return (
    Math.sin(nx + t * 0.35) * Math.cos(ny - t * 0.28) +
    0.5 * Math.sin(nx * 0.5 - t * 0.18 + 1.7) * Math.cos(ny * 0.6 + t * 0.22)
  );
}

/**
 * Divergence-free turbulence at world position `(x, y)` and time `t`, as the curl of {@link
 * potential}: `(∂φ/∂y, -∂φ/∂x)`, approximated by central differences. Result components land in
 * roughly [-1.5, 1.5]; the engine scales them to a px/s drift. Because the field has no sources or
 * sinks, advected particles swirl and eddy instead of clumping — the "vortices" of natural drift.
 *
 * Returns the shared {@link CURL_SCRATCH} vector (overwritten by the next call), so the per-frame
 * hot path stays allocation-free — read the components before calling again.
 */
export function curlField(x: number, y: number, t: number): Vec2 {
  const nx = x / EDDY_SCALE;
  const ny = y / EDDY_SCALE;
  const dPhiDy = (potential(nx, ny + CURL_EPS, t) - potential(nx, ny - CURL_EPS, t)) / (2 * CURL_EPS);
  const dPhiDx = (potential(nx + CURL_EPS, ny, t) - potential(nx - CURL_EPS, ny, t)) / (2 * CURL_EPS);
  CURL_SCRATCH.x = dPhiDy;
  CURL_SCRATCH.y = -dPhiDx;
  return CURL_SCRATCH;
}

/** Smoothstep of `t` clamped to [0, 1] — the zero-derivative-at-both-ends ease every envelope uses. */
export function smooth01(t: number): number {
  const c = t < 0 ? 0 : t > 1 ? 1 : t;
  return c * c * (3 - 2 * c);
}

/**
 * Deterministic pseudo-random in [0, 1) from an integer counter (the classic fract-sin hash).
 * Decoration-grade only — it seeds *when* a storm or gust happens, never anything security- or
 * fairness-sensitive — and being a pure function of the counter is the whole point: the "random"
 * event schedule is reproducible, so it can be unit-tested and never drifts between frames.
 */
function hash01(n: number, seed = 0): number {
  const s = Math.sin(n * 127.1 + seed * 311.7 + 0.13) * 43758.5453;
  return s - Math.floor(s);
}

/**
 * Blizzard scheduler constants. Time is cut into fixed epochs; a hash of the epoch index decides
 * whether it carries a storm, when in the epoch it starts, how long it holds and which way it
 * blows. The envelope shape follows observed squalls (and the discrete-gust modelling standard):
 * a rise over a few seconds, a sustained core, and a slower die-away.
 */
const BLIZZARD = {
  /** Epoch length (s). With `prob`, storms average one per ~5 minutes of running time. */
  epoch: 130,
  /** Chance a given epoch carries a storm. */
  prob: 0.42,
  /** Envelope ramp-up / die-away times (s) — onset is faster than decay, like a real squall. */
  attack: 5,
  decay: 11,
  /** Full-strength hold range (s), hashed per storm. */
  hold: [10, 26] as const,
} as const;

/** The shape shared by every epoch-hashed event scheduler. */
interface SpellConfig {
  readonly epoch: number;
  readonly prob: number;
  readonly attack: number;
  readonly decay: number;
  readonly hold: readonly [number, number];
}

/**
 * The shared epoch-hash spell envelope in [0, 1]: cut time into `cfg.epoch`-second epochs, hash
 * (with `seed` decorrelating the different event kinds) whether each epoch carries an event, when
 * it starts, and how long it holds; ramp with smoothstep attack/decay. Every event is strictly
 * contained in its epoch (span ≤ epoch by construction — asserted by the configs' tests), and
 * epoch 0 is always quiet so the layer never opens mid-event. `seed` = 0 reproduces the original
 * blizzard schedule byte-for-byte (its hashes used seeds 0/1/2 before this was factored out).
 */
function spell(t: number, cfg: SpellConfig, seed = 0): number {
  if (t < cfg.epoch) return 0;
  const e = Math.floor(t / cfg.epoch);
  if (hash01(e, seed) >= cfg.prob) return 0;
  const hold = cfg.hold[0] + (cfg.hold[1] - cfg.hold[0]) * hash01(e, seed + 1);
  const span = cfg.attack + hold + cfg.decay;
  const start = e * cfg.epoch + hash01(e, seed + 2) * (cfg.epoch - span);
  const u = t - start;
  if (u <= 0 || u >= span) return 0;
  return Math.min(smooth01(u / cfg.attack), smooth01((span - u) / cfg.decay));
}

/**
 * Blizzard intensity envelope in [0, 1]: zero for minutes at a time, occasionally rising through
 * a storm that holds and dies away. Deterministic (see {@link hash01}) and always calm in the
 * first epoch, so the layer never opens mid-whiteout: the calm effect establishes itself first.
 */
export function blizzard(t: number): number {
  return spell(t, BLIZZARD);
}

/**
 * The blizzard's wind, signed by its hashed per-storm direction: {@link blizzard} × ±1. A storm
 * blows one way for its whole life (squalls have a prevailing direction), and because the
 * envelope is zero at both ends the direction never flips visibly between storms.
 */
export function blizzardWind(t: number): number {
  const env = blizzard(t);
  if (env === 0) return 0;
  const e = Math.floor(t / BLIZZARD.epoch);
  return hash01(e, 3) < 0.5 ? -env : env;
}

/**
 * Discrete-gust constants. Real gusts are short *events* over the smooth background wander —
 * the standard engineering model is the "1-cosine" ramp (attack of a second or two, slower
 * decay), typically followed by a lull below the mean. Epoch-hashed like {@link blizzard}.
 */
const PULSE = {
  epoch: 24,
  prob: 0.55,
  /** Attack / decay ranges (s), hashed per event; decay is the longer side. */
  attack: [1, 3] as const,
  decay: [3.5, 7] as const,
  /** Peak strength range, hashed per event. */
  amp: [0.45, 1] as const,
  /** The trailing lull's depth as a fraction of the pulse's own amplitude. */
  lull: 0.25,
} as const;

/**
 * Occasional discrete gust in [-1, 1]: usually zero, with hashed events that shove the field one
 * way — a fast 1-cosine attack, a slower 1-cosine decay, then a shallow lull *below* zero (the
 * die-down overshoot real gusts show) before settling. The sign is the event's hashed direction;
 * both ends of the shape have zero slope, so pulses splice into the smooth wind without a kink.
 */
export function gustPulse(t: number): number {
  const e = Math.floor(t / PULSE.epoch);
  if (hash01(e, 7) >= PULSE.prob) return 0;
  const attack = PULSE.attack[0] + (PULSE.attack[1] - PULSE.attack[0]) * hash01(e, 8);
  const decay = PULSE.decay[0] + (PULSE.decay[1] - PULSE.decay[0]) * hash01(e, 9);
  const span = attack + decay * 2; // decay window + an equal lull window
  const start = e * PULSE.epoch + hash01(e, 10) * (PULSE.epoch - span);
  const u = t - start;
  if (u <= 0 || u >= span) return 0;
  const amp = PULSE.amp[0] + (PULSE.amp[1] - PULSE.amp[0]) * hash01(e, 11);
  const dir = hash01(e, 12) < 0.5 ? -1 : 1;
  let shape: number;
  if (u < attack) {
    shape = 0.5 * (1 - Math.cos((Math.PI * u) / attack));
  } else if (u < attack + decay) {
    shape = 0.5 * (1 + Math.cos((Math.PI * (u - attack)) / decay));
  } else {
    // The lull: a shallow half-sine dip below zero, easing back to calm.
    shape = -PULSE.lull * Math.sin((Math.PI * (u - attack - decay)) / decay);
  }
  return dir * amp * shape;
}

/**
 * Snow-squall scheduler: unlike the blizzard's minutes-of-warning build, a squall *slams* in —
 * the NWS definition is a sudden, brief, intense burst of snowfall with a whiteout-grade
 * visibility crash, over within the hour (scaled here to seconds). So: near-instant attack,
 * short hold, quick clear-out.
 */
const SQUALL = {
  epoch: 90,
  prob: 0.3,
  attack: 1.5,
  decay: 4,
  hold: [6, 12] as const,
} as const;

/** Squall intensity envelope in [0, 1] — the sudden dense dump, distinct from a blizzard's rake. */
export function squall(t: number): number {
  return spell(t, SQUALL, 20);
}

/**
 * Diamond-dust scheduler: the clear-sky ice-crystal haze of deeply cold, *calm* air. It doesn't
 * arrive — it shimmers into being and fades away again, so the ramps are the slowest here and
 * the spell holds the longest.
 */
const DIAMOND_DUST = {
  epoch: 110,
  prob: 0.28,
  attack: 5,
  decay: 7,
  hold: [14, 28] as const,
} as const;

/** Diamond-dust intensity envelope in [0, 1]. The engine suppresses it while storms blow. */
export function diamondDust(t: number): number {
  return spell(t, DIAMOND_DUST, 30);
}

/**
 * Graupel-shower scheduler: a brief rattle of dense, rimed snow pellets — fast, straight,
 * bouncy — the kind of shower that passes in a minute. Quick attack, short hold.
 */
const GRAUPEL = {
  epoch: 100,
  prob: 0.24,
  attack: 2,
  decay: 3.5,
  hold: [8, 16] as const,
} as const;

/** Graupel-shower intensity envelope in [0, 1]. */
export function graupelShower(t: number): number {
  return spell(t, GRAUPEL, 40);
}

/**
 * Warm-snow scheduler: spells of big, clumpy aggregate flakes — snow falling near 0 °C sticks
 * together into fat lazy clumps whose fall speed is nearly size-independent (the aggregate
 * fall-speed exponent is ~0.1–0.2), the classic cosy movie-snow look. Gradual and common: this
 * is a mood, not a storm.
 */
const WARM_SNOW = {
  epoch: 70,
  prob: 0.4,
  attack: 8,
  decay: 10,
  hold: [18, 36] as const,
} as const;

/** Warm-snow ("big lazy aggregate flakes") intensity envelope in [0, 1]. */
export function warmSnow(t: number): number {
  return spell(t, WARM_SNOW, 60);
}

/**
 * Dead-air scheduler: the still spell between systems, when the wind drops out and flakes fall
 * in slow, near-vertical, laminar paths. The envelope *damps* the wind terms rather than adding
 * anything — and it makes the storms read harder by contrast.
 */
const DEAD_AIR = {
  epoch: 85,
  prob: 0.3,
  attack: 4,
  decay: 5,
  hold: [8, 18] as const,
} as const;

/** Dead-air ("wind drops out") intensity envelope in [0, 1]. */
export function deadAir(t: number): number {
  return spell(t, DEAD_AIR, 70);
}

/**
 * Thundersnow flash timing. Real lightning rises in well under a millisecond and a flash is
 * usually several return strokes flickering over a few hundred milliseconds — so the envelope
 * is deliberately discontinuous: each stroke steps on instantly and decays linearly, and the
 * flash's read is the flicker, not a fade-in. `dense` is the lab's forced-thundersnow cadence
 * (a flash every few seconds); the natural cadence relies on the engine gating flashes behind
 * a deep blizzard, which is what makes real thundersnow rare.
 */
const LIGHTNING = {
  natural: { epoch: 7, prob: 0.32 },
  dense: { epoch: 3.5, prob: 0.85 },
  /** Stroke offsets into the event (s) and their relative brightness. */
  strokes: [
    { at: 0, amp: 1 },
    { at: 0.14, amp: 0.55 },
    { at: 0.34, amp: 0.8 },
  ],
  /** Per-stroke linear decay time (s). */
  strokeDecay: 0.16,
  /** Total event window (s) — covers the last stroke at max jitter (0.34 + 0.08) plus decay. */
  span: 0.6,
} as const;

/** Thundersnow flash intensity in [0, 1]: zero almost always, stepping through stroke flickers. */
export function lightningFlash(t: number, dense = false): number {
  const cfg = dense ? LIGHTNING.dense : LIGHTNING.natural;
  const e = Math.floor(t / cfg.epoch);
  if (hash01(e, 50) >= cfg.prob) return 0;
  const start = e * cfg.epoch + hash01(e, 51) * (cfg.epoch - LIGHTNING.span);
  const u = t - start;
  if (u <= 0 || u >= LIGHTNING.span) return 0;
  // Stroke jitter per event, so consecutive flashes don't flicker identically.
  const jitter = hash01(e, 52) * 0.08;
  let peak = 0;
  for (let i = 0; i < LIGHTNING.strokes.length; i++) {
    const s = LIGHTNING.strokes[i];
    if (!s) continue;
    const at = s.at === 0 ? 0 : s.at + jitter;
    const du = u - at;
    if (du < 0 || du >= LIGHTNING.strokeDecay) continue;
    const v = s.amp * (1 - du / LIGHTNING.strokeDecay);
    if (v > peak) peak = v;
  }
  return peak;
}
