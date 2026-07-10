/**
 * Foundry milestone success burst (visual-flair F4).
 *
 * A single {@link BurstProvider} mounted near the app root owns one fixed, `pointer-events-none`
 * overlay and exposes an imperative {@link useBurst} trigger. Any feature can call `burst()` on a
 * genuine milestone moment — the first item ever added, a completed stock-take — and a brief,
 * tasteful spark burst plays once from a point and then cleans itself up. It is deliberately
 * fire-and-forget: the caller doesn't render or dispose anything; each burst self-removes from
 * state once its animation has run, leaving no lingering DOM or opacity behind.
 *
 * Why a provider (like {@link ToastProvider}) rather than a per-call-site component: the animation
 * lives in exactly one place, so no call site hand-rolls particles, and a burst can fire from a
 * dialog that is itself about to close without being torn down mid-play.
 *
 * Design constraints (see the `gubbins-burst-*` keyframes in `styles/index.css`):
 *  - **Compositor-only** — sparks animate `transform` + `opacity` only (no layout/paint thrash),
 *    with `will-change` hints; the particle count is capped in {@link buildBurstParticles}.
 *  - **Tokens only** — every colour is a brand token (`--primary` / `--highlight`) that tracks the
 *    user's accent, so the burst recolours for free with their Colour.
 *  - **Reduced motion is nothing** — when decorative motion is suppressed (OS
 *    `prefers-reduced-motion` OR the F9 "Reduce effects" switch, resolved live via
 *    {@link useDecorationMotionReduced}) `burst()` is a no-op that renders no particle at all; the
 *    milestone is announced elsewhere (a toast, the audit summary's static glyph), never by this
 *    animation.
 *
 * The burst is purely decorative and marked `aria-hidden`; it is never the sole signal of an
 * achievement. Consistent with that, {@link useBurst} degrades to a no-op when no provider is
 * present (e.g. an isolated component test) rather than throwing — a missing decoration must never
 * break a screen.
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import {
  buildBurstParticles,
  BURST_DURATION_MS,
  type BurstParticle,
  type Rng,
} from './success-burst-geometry';
import { type MediaQueryProvider } from './useReducedMotion';
import { useDecorationMotionReduced } from './decoration-motion';

/** Viewport (client) coordinates the burst radiates from. */
export interface BurstOrigin {
  readonly x: number;
  readonly y: number;
}

export interface BurstOptions {
  /**
   * Where the burst radiates from, in viewport coordinates. Defaults to the horizontal centre a
   * little above the middle of the viewport — a natural focal point that reads well whether the
   * milestone fired from a centred dialog or the page at large.
   */
  readonly origin?: BurstOrigin;
}

interface BurstContextValue {
  /** Play a one-shot success burst. A no-op under reduced motion. */
  readonly burst: (options?: BurstOptions) => void;
}

/** A live burst instance held in provider state until its animation has run. */
interface ActiveBurst {
  readonly id: string;
  readonly x: number;
  readonly y: number;
  readonly particles: readonly BurstParticle[];
}

const BurstContext = createContext<BurstContextValue | null>(null);

/** The soft ring's diameter at full expansion, px. */
const RING_SIZE = 128;

/** The brand-token CSS variable each spark hue maps to (accent-tracked — see the Colour axis). */
const HUE_VAR: Record<BurstParticle['hue'], string> = {
  primary: 'var(--primary)',
  highlight: 'var(--highlight)',
};

/** Resolve the default origin — centre-ish of the current viewport, guarded for non-DOM envs. */
function defaultOrigin(): BurstOrigin {
  const w = typeof window !== 'undefined' ? window.innerWidth : 0;
  const h = typeof window !== 'undefined' ? window.innerHeight : 0;
  return { x: w / 2, y: h * 0.42 };
}

export interface BurstProviderProps {
  readonly children: ReactNode;
  /** Test seam: reduced-motion provider (defaults to the real `matchMedia`). */
  readonly motionProvider?: MediaQueryProvider;
  /** Test seam: deterministic RNG for particle layout (defaults to `Math.random`). */
  readonly rng?: Rng;
}

export function BurstProvider({ children, motionProvider, rng }: BurstProviderProps) {
  const reduced = useDecorationMotionReduced(motionProvider);
  const [bursts, setBursts] = useState<readonly ActiveBurst[]>([]);

  // `burst` is a stable callback, so read the live reduced-motion flag through a ref rather than
  // closing over it — otherwise a preference change mid-session wouldn't be respected.
  const reducedRef = useRef(reduced);
  useEffect(() => {
    reducedRef.current = reduced;
  }, [reduced]);

  // Pending self-removal timers, keyed by burst id — cleared on unmount so nothing fires after.
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  useEffect(() => {
    const map = timers.current;
    return () => {
      for (const t of map.values()) clearTimeout(t);
      map.clear();
    };
  }, []);

  const burst = useCallback(
    (options?: BurstOptions) => {
      // Reduced motion degrades to nothing: no particle is ever rendered. The milestone is
      // surfaced by a toast / the summary glyph, so nothing is lost for these users.
      if (reducedRef.current) return;
      const id = crypto.randomUUID();
      const origin = options?.origin ?? defaultOrigin();
      const particles = buildBurstParticles(undefined, rng);
      setBursts((current) => [...current, { id, x: origin.x, y: origin.y, particles }]);
      // Self-clean once the animation has run (+ a small buffer so the last frame paints).
      timers.current.set(
        id,
        setTimeout(() => {
          timers.current.delete(id);
          setBursts((current) => current.filter((b) => b.id !== id));
        }, BURST_DURATION_MS + 100),
      );
    },
    [rng],
  );

  const value = useMemo<BurstContextValue>(() => ({ burst }), [burst]);

  return (
    <BurstContext.Provider value={value}>
      {children}
      {bursts.length > 0 ? (
        <div
          aria-hidden
          className="pointer-events-none fixed inset-0 z-[70] overflow-hidden"
          data-testid="burst-overlay"
        >
          {bursts.map((b) => (
            <div key={b.id} className="absolute" style={{ left: b.x, top: b.y }} data-testid="burst">
              {/* Soft expanding ring behind the sparks, centred on the origin. */}
              <span
                aria-hidden
                className="animate-burst-ring absolute rounded-full"
                style={{
                  width: RING_SIZE,
                  height: RING_SIZE,
                  left: -RING_SIZE / 2,
                  top: -RING_SIZE / 2,
                  border: '2px solid color-mix(in oklab, var(--primary) 50%, transparent)',
                  willChange: 'transform, opacity',
                }}
              />
              {b.particles.map((p) => (
                <span
                  key={p.id}
                  aria-hidden
                  data-testid="burst-particle"
                  className="animate-burst-spark absolute rounded-full"
                  style={{
                    width: p.size,
                    height: p.size,
                    left: -p.size / 2,
                    top: -p.size / 2,
                    backgroundColor: HUE_VAR[p.hue],
                    animationDelay: `${p.delayMs}ms`,
                    willChange: 'transform, opacity',
                    // Consumed by the `gubbins-burst-spark` keyframe as the outward end-point.
                    ['--burst-dx' as string]: `${p.dx}px`,
                    ['--burst-dy' as string]: `${p.dy}px`,
                  }}
                />
              ))}
            </div>
          ))}
        </div>
      ) : null}
    </BurstContext.Provider>
  );
}

/**
 * Imperative trigger for the milestone success burst. Returns `{ burst }`; calling `burst()` plays
 * one celebratory burst (a no-op under reduced motion). Degrades to a no-op when rendered without
 * a {@link BurstProvider} — a decorative effect must never throw or break a screen.
 */
export function useBurst(): BurstContextValue {
  const value = useContext(BurstContext);
  return value ?? NO_OP;
}

const NO_OP: BurstContextValue = { burst: () => {} };
