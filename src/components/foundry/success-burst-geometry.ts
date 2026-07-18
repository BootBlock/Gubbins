/**
 * Pure geometry for the Foundry milestone success burst (visual-flair F4). Separated from the
 * {@link BurstProvider} component so the particle maths is unit-testable without a DOM: given a
 * particle count, a `reach` (how far the furthest spark travels) and an injectable RNG for
 * deterministic tests, it lays out a full-page shell of sparks radiating from the burst origin,
 * each with an outward offset, a gravity drop, size, colour role, its own duration and a stagger.
 * The component only turns these descriptors into `transform`/`opacity` styles.
 *
 * The burst is a *firework*: it fills the viewport and plays for a few seconds. Everything is
 * still bounded on purpose — the count is capped and the radii/sizes/durations are clamped — so it
 * stays a fixed, compositor-only cost that can never become expensive however it is called.
 */

/** How many sparks a burst emits. Capped so the cost of a burst is bounded and predictable. */
export const BURST_PARTICLE_COUNT = 96;

/** How long (ms) the burst animation runs before the provider unmounts it. Matches the CSS. */
export const BURST_DURATION_MS = 4400;

/**
 * Default travel of the furthest spark from the origin, in px, when no viewport-derived reach is
 * supplied (non-DOM environments). The provider passes the real half-diagonal of the viewport so
 * the sparks actually carry into every corner of the page.
 */
export const DEFAULT_BURST_REACH = 720;

/** The reach a spark may travel is clamped to this band, so a huge display can't run away with it. */
const MIN_REACH = 240;
const MAX_REACH = 1600;

/** Fraction of `reach` the *nearest* spark travels — the shell has depth, not one hard ring. */
const MIN_REACH_FRACTION = 0.35;

/** Spark size range, in px. Larger than a pop needs — these have to read from across the page. */
const MIN_SIZE = 6;
const MAX_SIZE = 16;

/** Per-spark flight duration band, ms — keeps the whole effect inside a 3–5s window. */
const MIN_DURATION_MS = 3000;
const MAX_DURATION_MS = 4000;

/** How far a spark sags under "gravity" as it fades, as a fraction of `reach`. */
const MIN_DROP_FRACTION = 0.08;
const MAX_DROP_FRACTION = 0.3;

/** The two accent-tracking brand token roles a spark is tinted from (alternating). */
export type BurstHue = 'primary' | 'highlight';

/** A single spark's layout — consumed by the provider to build its inline transform. */
export interface BurstParticle {
  readonly id: number;
  /** Outward horizontal travel from the origin, px. */
  readonly dx: number;
  /** Outward vertical travel from the origin, px. */
  readonly dy: number;
  /** Extra downward sag applied at the end of the flight, px — the firework's gravity. */
  readonly drop: number;
  /** Diameter, px. */
  readonly size: number;
  /** How long this spark's flight lasts, ms. */
  readonly durationMs: number;
  /** Per-spark entrance stagger, ms — a light shimmer so they don't fire in perfect lockstep. */
  readonly delayMs: number;
  /** Which brand token tints this spark. */
  readonly hue: BurstHue;
}

/** A deterministic-in-tests source of `[0, 1)` randomness. Defaults to `Math.random`. */
export type Rng = () => number;

const lerp = (min: number, max: number, t: number): number => min + (max - min) * t;
const clamp = (value: number, min: number, max: number): number => Math.min(Math.max(value, min), max);

/**
 * Lay out a burst's sparks around a full circle. Angles are evenly spaced with a little
 * per-spark jitter so the shell feels organic rather than mechanical; radius, size, duration and
 * gravity drop vary within their clamped ranges. `count` is floored at 0 and capped at
 * {@link BURST_PARTICLE_COUNT}, and `reach` is clamped to a sane band, so a caller can never ask
 * for an unbounded (expensive) burst.
 */
export function buildBurstParticles(
  count: number = BURST_PARTICLE_COUNT,
  rng: Rng = Math.random,
  reach: number = DEFAULT_BURST_REACH,
): readonly BurstParticle[] {
  const n = Math.min(Math.max(Math.floor(count), 0), BURST_PARTICLE_COUNT);
  const maxRadius = clamp(Number.isFinite(reach) ? reach : DEFAULT_BURST_REACH, MIN_REACH, MAX_REACH);
  const minRadius = maxRadius * MIN_REACH_FRACTION;
  const particles: BurstParticle[] = [];
  for (let i = 0; i < n; i++) {
    // Evenly spaced base angle + up to ±half a slice of jitter, so sparks never perfectly overlap.
    const slice = (Math.PI * 2) / n;
    const angle = i * slice + (rng() - 0.5) * slice;
    const radius = lerp(minRadius, maxRadius, rng());
    particles.push({
      id: i,
      dx: Math.cos(angle) * radius,
      dy: Math.sin(angle) * radius,
      drop: maxRadius * lerp(MIN_DROP_FRACTION, MAX_DROP_FRACTION, rng()),
      size: lerp(MIN_SIZE, MAX_SIZE, rng()),
      durationMs: Math.round(lerp(MIN_DURATION_MS, MAX_DURATION_MS, rng())),
      // A wider stagger than a pop needs: the shell keeps throwing sparks for the first third of a
      // second, which is what makes it read as a firework rather than one synchronised ring.
      delayMs: Math.round(rng() * 320),
      hue: i % 2 === 0 ? 'primary' : 'highlight',
    });
  }
  return particles;
}
