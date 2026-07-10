/**
 * usePointerTilt — the single reusable seam for the Foundry pointer tilt/parallax/glare
 * (visual-flair F7). A card that spreads the returned handlers gains a subtle 3D lean toward the
 * cursor, a counter-parallax drift of its hero layer, and a soft specular glare that tracks the
 * pointer — settling flat on pointer-leave. The pure maths + the motion gate live in
 * {@link ./pointer-tilt}; this hook owns the pointer plumbing and the CSS-var writes in ONE place
 * so no call site hand-rolls the rAF throttle, the decoration-motion gate (OS reduced-motion OR
 * the F9 "Reduce effects" switch), or the fine-pointer guard.
 *
 * **Gate (mirrors the F6 view-transition seam).** The handlers are returned only when decorative
 * motion is permitted *and* the device has a fine pointer — {@link computeShouldTilt} (fed by the
 * reactive {@link useDecorationMotionReduced}) ANDed with a live `(pointer: fine)` read. When the
 * gate is off the hook
 * returns an empty object, so the card attaches **no listeners at all** (belt-and-braces with the
 * CSS, which scopes every active rule to `(pointer: fine) and (prefers-reduced-motion:
 * no-preference)`, and with the global reduced-motion catch-all). The effect is pure decoration:
 * it never touches the focus ring, hover-lift, `selected` ring or the F5 spotlight border.
 *
 * **Cheap on the virtualised grid.** Each `pointermove` only stashes the coordinates and schedules
 * a single `requestAnimationFrame`; the frame reads one `getBoundingClientRect` and writes six CSS
 * custom properties directly on the element — no React state, so a moving pointer never re-renders
 * the card (its `memo` stays effective) and only the ONE hovered card does any work. Writing only
 * `transform`/`translate`/`opacity`-backing custom properties keeps the work compositor-friendly.
 */
import { useCallback, useEffect, useMemo, useRef, type PointerEvent as ReactPointerEvent } from 'react';
import {
  computeShouldTilt,
  computeTilt,
  DEFAULT_TILT_CONFIG,
  FINE_POINTER_QUERY,
  REST_TILT_VARS,
  type TiltConfig,
  type TiltVars,
} from './pointer-tilt';
import { type MediaQueryProvider } from './useReducedMotion';
import { useDecorationFlourishReduced } from './decoration-motion';
import { useMediaQuery } from './useMediaQuery';

/** Options for {@link usePointerTilt}. All optional — the defaults suit the Visual-density card. */
export interface PointerTiltOptions extends Partial<TiltConfig> {
  /**
   * Injectable `matchMedia` provider — used for both the reduced-motion and fine-pointer reads,
   * exactly as the sibling foundry hooks do, so the gate is component-testable with a fake
   * `MediaQueryList` and never needs a real browser. Production callers omit it.
   */
  readonly mediaProvider?: MediaQueryProvider;
}

/** The handlers a tilting element spreads onto its root. Empty when the gate is off. */
export interface PointerTiltHandlers {
  readonly onPointerMove?: (event: ReactPointerEvent<HTMLElement>) => void;
  readonly onPointerLeave?: (event: ReactPointerEvent<HTMLElement>) => void;
}

/** Write a resolved {@link TiltVars} set onto the element as `--tilt-*` custom properties. */
function writeTiltVars(el: HTMLElement, vars: TiltVars): void {
  const { style } = el;
  style.setProperty('--tilt-rx', `${vars.rx}deg`);
  style.setProperty('--tilt-ry', `${vars.ry}deg`);
  style.setProperty('--tilt-px', `${vars.px}px`);
  style.setProperty('--tilt-py', `${vars.py}px`);
  style.setProperty('--tilt-gx', `${vars.gx}%`);
  style.setProperty('--tilt-gy', `${vars.gy}%`);
}

/**
 * Returns `{ onPointerMove, onPointerLeave }` to spread on a card when tilt is warranted, else an
 * empty object (no listeners). See the module header for the gate and perf model.
 */
export function usePointerTilt(options: PointerTiltOptions = {}): PointerTiltHandlers {
  const { maxTiltDeg, parallaxPx, mediaProvider } = options;
  const config = useMemo<TiltConfig>(
    () => ({
      maxTiltDeg: maxTiltDeg ?? DEFAULT_TILT_CONFIG.maxTiltDeg,
      parallaxPx: parallaxPx ?? DEFAULT_TILT_CONFIG.parallaxPx,
    }),
    [maxTiltDeg, parallaxPx],
  );

  // Tilt/parallax is a "flourish" — suppressed one tier earlier than general motion (at Balanced).
  const reduced = useDecorationFlourishReduced(mediaProvider);
  const finePointer = useMediaQuery(FINE_POINTER_QUERY, mediaProvider);
  const enabled = computeShouldTilt(reduced) && finePointer;

  // The pending frame + its payload live in refs so a moving pointer never re-renders the card.
  const frameRef = useRef<number | null>(null);
  const pendingRef = useRef<{ el: HTMLElement; x: number; y: number } | null>(null);

  const cancelFrame = useCallback(() => {
    if (frameRef.current != null) {
      cancelAnimationFrame(frameRef.current);
      frameRef.current = null;
    }
  }, []);

  // rAF flush: read the card's geometry once and write the resolved vars. Reading the rect here
  // (not per move) coalesces to at most one layout read per frame, and the only writes are
  // transform-backing custom properties, so there is no read/write layout-thrash loop.
  const flush = useCallback(() => {
    frameRef.current = null;
    const pending = pendingRef.current;
    if (!pending) return;
    const rect = pending.el.getBoundingClientRect();
    writeTiltVars(
      pending.el,
      computeTilt(pending.x - rect.left, pending.y - rect.top, rect.width, rect.height, config),
    );
  }, [config]);

  const onPointerMove = useCallback(
    (event: ReactPointerEvent<HTMLElement>) => {
      // Two per-event guards on top of the render-time gate:
      //  - `touch`: `(pointer: fine)` reflects the *primary* pointer, so on a hybrid device (a
      //    laptop with a touchscreen) the handlers are attached even though a finger is coarse.
      //    Tilt is a hover affordance — never run it for an actual touch pointer.
      //  - buttons held: a press-drag (the item drag-to-move gesture, or any button-held move) is
      //    not a hover; tilting the source card while the floating drag preview follows reads as a
      //    distracting double-motion. Only a plain, no-button hover tilts.
      if (event.pointerType === 'touch' || event.buttons !== 0) return;
      pendingRef.current = { el: event.currentTarget, x: event.clientX, y: event.clientY };
      if (frameRef.current == null) frameRef.current = requestAnimationFrame(flush);
    },
    [flush],
  );

  const onPointerLeave = useCallback(
    (event: ReactPointerEvent<HTMLElement>) => {
      cancelFrame();
      pendingRef.current = null;
      // Reset to flat so a later re-hover starts level (the CSS reverts the transform on
      // `:hover` loss regardless, but stale vars would otherwise flash on the next entry).
      writeTiltVars(event.currentTarget, REST_TILT_VARS);
    },
    [cancelFrame],
  );

  // A tilt in flight when the gate flips off (the user enables reduced motion mid-hover, or the
  // handlers are about to be dropped) must not leave a frame queued.
  useEffect(() => cancelFrame, [cancelFrame]);

  return enabled ? { onPointerMove, onPointerLeave } : {};
}
