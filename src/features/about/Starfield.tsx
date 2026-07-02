import { type CSSProperties, useMemo } from 'react';

/**
 * Decorative starfield for the About screen — a lightweight, compositor-only
 * effect (see the `.gubbins-star` / `.gubbins-flare` rules in styles/index.css).
 *
 * Stars are generated once (memoised) into a small fixed set of absolutely-placed
 * dots that twinkle (opacity) and drift horizontally (transform) at varying
 * speeds, plus a few larger "lens-flare" stars whose glow breathes via a scale
 * pulse. The whole layer is `aria-hidden` and `pointer-events-none`, sits behind
 * the content (`-z-10` under the screen's `isolate`), and is theme-aware through
 * the `--star` / `--star-flare` tokens (dark dots on the light theme). Animations
 * are pure opacity/transform; the global reduced-motion rule freezes them to a
 * calm static sky (every element's base style is its visible resting state).
 */
const SMALL_STAR_COUNT = 48;
const FLARE_COUNT = 4;

interface Star {
  readonly top: number;
  readonly left: number;
  readonly size: number;
  readonly duration: number;
  readonly delay: number;
  readonly driftX: number;
  readonly driftDur: number;
  readonly driftDelay: number;
}

interface StarRanges {
  readonly size: readonly [number, number];
  readonly dur: readonly [number, number];
  readonly driftAmp: readonly [number, number];
  readonly driftDur: readonly [number, number];
}

/** A uniform random in [min, max). Positions/timings only — no security concern. */
function rand(min: number, max: number): number {
  return min + Math.random() * (max - min);
}

function makeStars(count: number, r: StarRanges): Star[] {
  return Array.from({ length: count }, () => {
    const driftDur = rand(r.driftDur[0], r.driftDur[1]);
    return {
      top: rand(0, 100),
      left: rand(0, 100),
      size: rand(r.size[0], r.size[1]),
      duration: rand(r.dur[0], r.dur[1]),
      delay: rand(0, r.dur[1]),
      // Signed amplitude so stars drift both ways.
      driftX: rand(r.driftAmp[0], r.driftAmp[1]) * (Math.random() < 0.5 ? -1 : 1),
      driftDur,
      driftDelay: rand(0, driftDur),
    };
  });
}

/** Shared drift custom properties (position + horizontal sway timeline). */
function driftVars(star: Star): Record<string, string> {
  return {
    top: `${star.top}%`,
    left: `${star.left}%`,
    '--drift': `${star.driftX.toFixed(1)}px`,
    '--drift-d': `${star.driftDur.toFixed(1)}s`,
    '--drift-delay': `${star.driftDelay.toFixed(1)}s`,
  };
}

/** Size + twinkle/pulse custom properties for the visible star/core element. */
function glyphVars(star: Star): Record<string, string> {
  return {
    '--s': `${star.size.toFixed(2)}px`,
    '--d': `${star.duration.toFixed(2)}s`,
    '--delay': `${star.delay.toFixed(2)}s`,
  };
}

export function Starfield() {
  const { stars, flares } = useMemo(
    () => ({
      // driftDur ranges are ~15% shorter than a 16–44s / 30–55s baseline, i.e. a
      // 15% faster horizontal drift (speed is inverse of duration).
      stars: makeStars(SMALL_STAR_COUNT, {
        size: [1, 2.6],
        dur: [3, 6.5],
        driftAmp: [6, 28],
        driftDur: [13.9, 38.3],
      }),
      flares: makeStars(FLARE_COUNT, {
        size: [2, 3.2],
        dur: [5, 9],
        driftAmp: [10, 24],
        driftDur: [26.1, 47.8],
      }),
    }),
    [],
  );

  return (
    <div aria-hidden className="gubbins-starfield pointer-events-none fixed inset-0 -z-10">
      {stars.map((star, i) => (
        <span key={`s${i}`} className="gubbins-star" style={{ ...driftVars(star), ...glyphVars(star) }} />
      ))}
      {flares.map((flare, i) => (
        // Wrapper drifts horizontally; the core owns the glow + scale pulse.
        <span key={`f${i}`} className="gubbins-flare" style={driftVars(flare) as CSSProperties}>
          <span className="gubbins-flare-core" style={glyphVars(flare) as CSSProperties} />
        </span>
      ))}
    </div>
  );
}
