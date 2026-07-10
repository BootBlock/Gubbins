/**
 * Pure geometry for the Foundry milestone success burst (visual-flair F4). Separated from the
 * {@link BurstProvider} component so the particle maths is unit-testable without a DOM: given a
 * particle count (and an injectable RNG for deterministic tests) it lays out a capped ring of
 * sparks radiating from the burst origin, each with an outward offset, size, colour role and a
 * small stagger. The component only turns these descriptors into `transform`/`opacity` styles.
 *
 * Everything is bounded on purpose — the count is capped and the radii/sizes are clamped — so the
 * burst stays a brief, tasteful pop rather than a screen-filling confetti storm, and can never
 * become expensive.
 */

/** How many sparks a burst emits. Capped low — this is a tasteful pop, not a confetti storm. */
export const BURST_PARTICLE_COUNT = 14;

/** How long (ms) the burst animation runs before the provider unmounts it. Matches the CSS. */
export const BURST_DURATION_MS = 900;

/** Inner / outer travel of a spark from the origin, in px. */
const MIN_RADIUS = 58;
const MAX_RADIUS = 104;

/** Spark size range, in px. */
const MIN_SIZE = 5;
const MAX_SIZE = 9;

/** The two accent-tracking brand token roles a spark is tinted from (alternating). */
export type BurstHue = 'primary' | 'highlight';

/** A single spark's layout — consumed by the provider to build its inline transform. */
export interface BurstParticle {
  readonly id: number;
  /** Outward horizontal travel from the origin, px. */
  readonly dx: number;
  /** Outward vertical travel from the origin, px. */
  readonly dy: number;
  /** Diameter, px. */
  readonly size: number;
  /** Per-spark entrance stagger, ms — a light shimmer so they don't fire in perfect lockstep. */
  readonly delayMs: number;
  /** Which brand token tints this spark. */
  readonly hue: BurstHue;
}

/** A deterministic-in-tests source of `[0, 1)` randomness. Defaults to `Math.random`. */
export type Rng = () => number;

const lerp = (min: number, max: number, t: number): number => min + (max - min) * t;

/**
 * Lay out a burst's sparks around a full circle. Angles are evenly spaced with a little
 * per-spark jitter so the ring feels organic rather than mechanical; radius and size vary within
 * their clamped ranges. `count` is floored at 0 and capped at {@link BURST_PARTICLE_COUNT} so a
 * caller can never ask for an unbounded (expensive) burst.
 */
export function buildBurstParticles(
  count: number = BURST_PARTICLE_COUNT,
  rng: Rng = Math.random,
): readonly BurstParticle[] {
  const n = Math.min(Math.max(Math.floor(count), 0), BURST_PARTICLE_COUNT);
  const particles: BurstParticle[] = [];
  for (let i = 0; i < n; i++) {
    // Evenly spaced base angle + up to ±half a slice of jitter, so sparks never perfectly overlap.
    const slice = (Math.PI * 2) / n;
    const angle = i * slice + (rng() - 0.5) * slice;
    const radius = lerp(MIN_RADIUS, MAX_RADIUS, rng());
    particles.push({
      id: i,
      dx: Math.cos(angle) * radius,
      dy: Math.sin(angle) * radius,
      size: lerp(MIN_SIZE, MAX_SIZE, rng()),
      delayMs: Math.round(rng() * 60),
      hue: i % 2 === 0 ? 'primary' : 'highlight',
    });
  }
  return particles;
}
