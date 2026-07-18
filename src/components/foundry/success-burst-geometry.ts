/**
 * Pure geometry for the Foundry milestone success burst (visual-flair F4). Separated from the
 * {@link BurstProvider} component so the particle maths is unit-testable without a DOM: given a
 * particle count, a `reach` (how far the furthest spark travels) and an injectable RNG for
 * deterministic tests, it lays out a full-page shell of sparks radiating from the burst origin,
 * each with an ejection vector, a gravity term, size, a hue offset, its own duration and a stagger.
 * The component only turns these descriptors into `transform`/`opacity` styles.
 *
 * **Ballistics, not a cartoon.** A spark is modelled as a real ember: it is thrown outward at
 * speed, is slowed by air resistance, and falls under gravity the whole time. The two forces are
 * kept as *separate* per-particle quantities here — the ejection vector (`dx`/`dy`) and the
 * gravity distance (`gravity`) — because the CSS keyframe combines them along different curves:
 * drag decays the ejection exponentially while the fall grows with the square of time. That is
 * what produces the characteristic firework droop, where a spark shoots out fast, stalls, and then
 * arcs downward. See the `gubbins-burst-spark` keyframe for the sampled curves.
 *
 * The burst fills the viewport and plays for a few seconds. Everything is still bounded on purpose
 * — the count is capped and the radii/sizes/durations are clamped — so it stays a fixed,
 * compositor-only cost that can never become expensive however it is called.
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

/** Fraction of `reach` the *slowest* spark is ejected — the shell has depth, not one hard ring. */
const MIN_REACH_FRACTION = 0.35;

/** Spark size range, in px. Larger than a pop needs — these have to read from across the page. */
const MIN_SIZE = 5;
const MAX_SIZE = 13;

/** Per-spark flight duration band, ms — keeps the whole effect inside a 3–5s window. */
const MIN_DURATION_MS = 3000;
const MAX_DURATION_MS = 4000;

/**
 * How far a spark falls over its flight, as a fraction of `reach`. Real embers vary in mass and
 * drag, so the spread is wide: light ones hang and drift, heavy ones drop out of the sky.
 */
const MIN_GRAVITY_FRACTION = 0.45;
const MAX_GRAVITY_FRACTION = 1.35;

/**
 * How far a spark's hue may sit either side of the accent's own hue, in degrees. A real shell burns
 * a *range* of temperatures rather than one flat colour, so each spark is offset around the brand
 * hue — close enough to read as the user's accent, varied enough to look like fire.
 */
export const BURST_HUE_SPREAD = 32;

/**
 * How much brighter a spark may burn than the base accent (added to OKLCH lightness). Only ever
 * positive: embers are hotter than the surface they came from, never duller.
 */
const MAX_LIGHTNESS_LIFT = 0.16;

/** A single spark's layout — consumed by the provider to build its inline transform. */
export interface BurstParticle {
  readonly id: number;
  /** Horizontal ejection distance from the origin, px — before drag and gravity are applied. */
  readonly dx: number;
  /** Vertical ejection distance from the origin, px — before drag and gravity are applied. */
  readonly dy: number;
  /** How far this spark falls over the whole flight, px — grows with the square of time. */
  readonly gravity: number;
  /** Diameter, px. */
  readonly size: number;
  /** How long this spark's flight lasts, ms. */
  readonly durationMs: number;
  /** Per-spark ignition stagger, ms — the shell's sparks catch a beat apart, not in lockstep. */
  readonly delayMs: number;
  /** Hue offset from the accent's own hue, degrees (± {@link BURST_HUE_SPREAD}). */
  readonly hueShift: number;
  /** Extra OKLCH lightness over the accent — how hot this particular ember burns. */
  readonly lightnessLift: number;
}

/** A deterministic-in-tests source of `[0, 1)` randomness. Defaults to `Math.random`. */
export type Rng = () => number;

/**
 * A spark's colour: the `--primary` token's own hue as the centre point, offset by this particle's
 * `hueShift` and lifted toward white by its `lightnessLift`. Relative-colour syntax keeps the
 * *token* as the source, so the shell still tracks the user's accent — it simply burns a range of
 * temperatures around it instead of one flat swatch.
 *
 * Pure and here (rather than inline in the provider) so the exact string is unit-testable: the
 * component test can't read it back, because a CSS parser without relative-colour support — the
 * test DOM included — drops the declaration entirely. That is the same path a browser without
 * support takes, and why every spark also carries a plain `bg-primary` class as the fallback.
 */
export function sparkColour(p: BurstParticle): string {
  return `oklch(from var(--primary) calc(l + ${p.lightnessLift.toFixed(3)}) c calc(h + ${p.hueShift}))`;
}

const lerp = (min: number, max: number, t: number): number => min + (max - min) * t;
const clamp = (value: number, min: number, max: number): number => Math.min(Math.max(value, min), max);

/**
 * Lay out a burst's sparks around a full circle. Angles are evenly spaced with a little per-spark
 * jitter so the shell feels organic rather than mechanical; ejection distance, size, duration,
 * gravity and colour temperature all vary within their clamped ranges. `count` is floored at 0 and
 * capped at {@link BURST_PARTICLE_COUNT}, and `reach` is clamped to a sane band, so a caller can
 * never ask for an unbounded (expensive) burst.
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
      gravity: maxRadius * lerp(MIN_GRAVITY_FRACTION, MAX_GRAVITY_FRACTION, rng()),
      size: lerp(MIN_SIZE, MAX_SIZE, rng()),
      durationMs: Math.round(lerp(MIN_DURATION_MS, MAX_DURATION_MS, rng())),
      // Tight, unlike a staggered cartoon twinkle: the shell bursts at once and the sparks merely
      // catch a few frames apart.
      delayMs: Math.round(rng() * 90),
      hueShift: Math.round(lerp(-BURST_HUE_SPREAD, BURST_HUE_SPREAD, rng())),
      // Skewed toward the hotter end (squared), so most sparks glow and only some sit at base.
      lightnessLift: MAX_LIGHTNESS_LIFT * rng() ** 2,
    });
  }
  return particles;
}
