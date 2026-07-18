/**
 * Foundry milestone success burst (visual-flair F4).
 *
 * A single {@link BurstProvider} mounted near the app root owns one fixed, `pointer-events-none`
 * overlay and exposes an imperative {@link useBurst} trigger. Any feature can call `burst()` on a
 * genuine milestone moment — the first item ever added, a completed stock-take — and a firework
 * plays once: a page-filling shell of sparks that carries into every corner of the viewport over
 * three to four seconds and then cleans itself up. It is deliberately fire-and-forget: the caller
 * doesn't render or dispose anything; each burst self-removes from state once its animation has
 * run, leaving no lingering DOM or opacity behind.
 *
 * Why a provider (like {@link ToastProvider}) rather than a per-call-site component: the animation
 * lives in exactly one place, so no call site hand-rolls particles, and a burst can fire from a
 * dialog that is itself about to close without being torn down mid-play.
 *
 * Design constraints (see the `gubbins-burst-*` keyframes in `styles/index.css`):
 *  - **GPU-only** — sparks animate `transform` (3D-composited via `translate3d`) + `opacity` and
 *    nothing else, so every frame is the compositor's work: no layout, no paint, no main-thread
 *    involvement once the animation is running. The overlay is promoted to its own layer and
 *    `contain`ed so the sparks can never invalidate the page beneath them, each spark carries a
 *    `will-change` hint, and the particle count is capped in {@link buildBurstParticles} so the
 *    number of composited layers is bounded regardless of viewport size.
 *  - **Tokens only** — colour comes from the `--primary` brand token, which tracks the user's
 *    accent. Each spark is offset around *that* token's hue in OKLCH rather than being given a
 *    literal of its own, so the shell burns a believable range of temperatures and still recolours
 *    for free with their Colour.
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
  sparkColour,
  BURST_DURATION_MS,
  DEFAULT_BURST_REACH,
  type BurstParticle,
  type Rng,
} from './success-burst-geometry';
import { type MediaQueryProvider } from './useReducedMotion';
import { useDecorationFlourishReduced } from './decoration-motion';

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
  /** How far the furthest spark travels, px — sized to the viewport when the burst was fired. */
  readonly reach: number;
  readonly particles: readonly BurstParticle[];
}

const BurstContext = createContext<BurstContextValue | null>(null);

/** The ignition flash's diameter as a fraction of the shell's reach — a bloom, not a full sweep. */
const FLASH_SIZE_FACTOR = 0.55;

/** How long the ignition flash lasts, ms — the light of the burst, gone before the sparks spread. */
const FLASH_DURATION_MS = 500;

/**
 * How many bursts may be in flight at once. Each one is now a page-filling shell that lives for
 * several seconds, so — unlike the old brief pop — repeated fires genuinely overlap, and each
 * carries ~100 composited layers. Retiring the oldest keeps the worst case bounded no matter how
 * often `burst()` is called (a milestone firing beside a stock-take, or the lab trigger held down).
 */
const MAX_ACTIVE_BURSTS = 3;

/** Resolve the default origin — centre-ish of the current viewport, guarded for non-DOM envs. */
function defaultOrigin(): BurstOrigin {
  const w = typeof window !== 'undefined' ? window.innerWidth : 0;
  const h = typeof window !== 'undefined' ? window.innerHeight : 0;
  return { x: w / 2, y: h * 0.42 };
}

/**
 * How far the sparks must travel from `origin` to reach the furthest corner of the viewport — the
 * distance to the corner diagonally opposite, so the shell genuinely fills the page from wherever
 * it was fired rather than stopping short. Falls back to the geometry default off-DOM.
 */
function reachFor(origin: BurstOrigin): number {
  if (typeof window === 'undefined') return DEFAULT_BURST_REACH;
  const { innerWidth: w, innerHeight: h } = window;
  if (!w || !h) return DEFAULT_BURST_REACH;
  return Math.hypot(Math.max(origin.x, w - origin.x), Math.max(origin.y, h - origin.y));
}

export interface BurstProviderProps {
  readonly children: ReactNode;
  /** Test seam: reduced-motion provider (defaults to the real `matchMedia`). */
  readonly motionProvider?: MediaQueryProvider;
  /** Test seam: deterministic RNG for particle layout (defaults to `Math.random`). */
  readonly rng?: Rng;
}

export function BurstProvider({ children, motionProvider, rng }: BurstProviderProps) {
  // The burst is a "flourish" — suppressed one tier earlier than general motion (at Balanced).
  const reduced = useDecorationFlourishReduced(motionProvider);
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
      const reach = reachFor(origin);
      const particles = buildBurstParticles(undefined, rng, reach);
      setBursts((current) =>
        [...current, { id, x: origin.x, y: origin.y, reach, particles }].slice(-MAX_ACTIVE_BURSTS),
      );
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
          // Promote the whole overlay to its own compositor layer and isolate it: the sparks then
          // animate entirely on the GPU and can never invalidate layout or paint of the page
          // beneath, however many are in flight.
          style={{
            transform: 'translateZ(0)',
            willChange: 'transform',
            contain: 'layout paint style',
          }}
        >
          {bursts.map((b) => {
            const flashSize = b.reach * FLASH_SIZE_FACTOR;
            return (
              <div key={b.id} className="absolute" style={{ left: b.x, top: b.y }} data-testid="burst">
                {/* The ignition flash: a soft bloom of light at the origin, gone in half a second. */}
                <span
                  aria-hidden
                  className="animate-burst-flash absolute rounded-full"
                  style={{
                    width: flashSize,
                    height: flashSize,
                    left: -flashSize / 2,
                    top: -flashSize / 2,
                    background:
                      'radial-gradient(closest-side, color-mix(in oklab, var(--primary) 70%, transparent), transparent)',
                    willChange: 'transform, opacity',
                    ['--burst-duration' as string]: `${FLASH_DURATION_MS}ms`,
                  }}
                />
                {b.particles.map((p) => (
                  <span
                    key={p.id}
                    aria-hidden
                    data-testid="burst-particle"
                    // `bg-primary` is the fallback that applies if the relative colour below is
                    // unsupported and therefore dropped — never a dead spark.
                    className="animate-burst-spark absolute rounded-full bg-primary"
                    style={{
                      width: p.size,
                      height: p.size,
                      left: -p.size / 2,
                      top: -p.size / 2,
                      backgroundColor: sparkColour(p),
                      animationDelay: `${p.delayMs}ms`,
                      willChange: 'transform, opacity',
                      // Consumed by the `gubbins-burst-spark` keyframe as the ejection vector, the
                      // gravity fall applied on its own curve, and this spark's own flight time.
                      ['--burst-dx' as string]: `${p.dx}px`,
                      ['--burst-dy' as string]: `${p.dy}px`,
                      ['--burst-gravity' as string]: `${p.gravity}px`,
                      ['--burst-duration' as string]: `${p.durationMs}ms`,
                    }}
                  />
                ))}
              </div>
            );
          })}
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
