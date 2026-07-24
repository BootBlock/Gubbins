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

/** The full on-screen length of the storm in a given epoch (attack + hashed hold + decay), in s. */
function blizzardSpan(e: number): number {
  const hold = BLIZZARD.hold[0] + (BLIZZARD.hold[1] - BLIZZARD.hold[0]) * hash01(e, 1);
  return BLIZZARD.attack + hold + BLIZZARD.decay;
}

/**
 * Blizzard intensity envelope in [0, 1]: zero for minutes at a time, occasionally rising through
 * a storm that holds and dies away. Deterministic (see {@link hash01}) and always calm in the
 * first epoch, so the layer never opens mid-whiteout: the calm effect establishes itself first.
 */
export function blizzard(t: number): number {
  if (t < BLIZZARD.epoch) return 0;
  const e = Math.floor(t / BLIZZARD.epoch);
  if (hash01(e) >= BLIZZARD.prob) return 0;
  const span = blizzardSpan(e);
  const start = e * BLIZZARD.epoch + hash01(e, 2) * (BLIZZARD.epoch - span);
  const u = t - start;
  if (u <= 0 || u >= span) return 0;
  return Math.min(smooth01(u / BLIZZARD.attack), smooth01((span - u) / BLIZZARD.decay));
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
