import { type CSSProperties, useEffect, useMemo } from 'react';
import { STARFIELD_VARIANTS } from '@/features/settings/theme-registry';
import { useBackdropStore } from '@/state/stores/useBackdropStore';

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
 *
 * The colour of the sky is chosen **at random each time the About screen opens**
 * (issue #61) from the {@link STARFIELD_VARIANTS} moods — no user setting. The pick
 * is projected as `data-starfield` on `<html>` (where the CSS variant blocks re-point
 * the `--star*` tokens), removed again on unmount. While the starfield is on screen it
 * also raises the {@link useBackdropStore} flag so the app-wide snow/rain weather layer
 * yields — the two full-viewport effects would otherwise fight for the same backdrop.
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
  const setBackdropActive = useBackdropStore((s) => s.setBackdropActive);

  // A fresh random mood per open (memoised so it holds steady across re-renders of a single visit).
  const variant = useMemo(
    () => STARFIELD_VARIANTS[Math.floor(Math.random() * STARFIELD_VARIANTS.length)],
    [],
  );

  // Project the chosen mood onto <html> for the CSS variant blocks, and flag that a full-viewport
  // backdrop is on screen so the weather layer yields. Both are undone on unmount (the base `cosmic`
  // look carries no attribute), restoring whatever was there before.
  useEffect(() => {
    const root = document.documentElement;
    const previous = root.dataset.starfield;
    if (variant === 'cosmic') delete root.dataset.starfield;
    else root.dataset.starfield = variant;
    setBackdropActive(true);
    return () => {
      if (previous === undefined) delete root.dataset.starfield;
      else root.dataset.starfield = previous;
      setBackdropActive(false);
    };
  }, [variant, setBackdropActive]);

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
