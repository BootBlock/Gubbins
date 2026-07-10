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
 *
 * None of this touches the DOM, so it is safe to import anywhere and trivial to test.
 */

/** A 2-D vector. Plain object; callers read it immediately, so no pooling is needed. */
export interface Vec2 {
  x: number;
  y: number;
}

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
 */
export function curlField(x: number, y: number, t: number): Vec2 {
  const nx = x / EDDY_SCALE;
  const ny = y / EDDY_SCALE;
  const dPhiDy = (potential(nx, ny + CURL_EPS, t) - potential(nx, ny - CURL_EPS, t)) / (2 * CURL_EPS);
  const dPhiDx = (potential(nx + CURL_EPS, ny, t) - potential(nx - CURL_EPS, ny, t)) / (2 * CURL_EPS);
  return { x: dPhiDy, y: -dPhiDx };
}
