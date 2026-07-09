/**
 * Reveal — a Foundry scroll-reveal wrapper (visual-flair F3). Wraps a widget or report
 * section so it holds invisible until it scrolls into view, then rises in once via the shared
 * `animate-rise` entrance, with an optional per-item stagger. The observer + reduced-motion
 * wiring lives in {@link useRevealOnScroll}; this is the ergonomic call-site wrapper.
 *
 * It is presentation only: the children are always in the DOM and readable from first paint
 * (the observer merely toggles a class), so screen-reader reading and focus order are never
 * gated on the reveal, and there is no layout shift that could move focus. Under reduced motion
 * or where IntersectionObserver is unavailable the content renders fully visible immediately.
 *
 * Never wrap the virtualised inventory list — its rows recycle on scroll and would re-fire the
 * entrance (see the `ease-emphasized` motion note). Reveal is for non-virtualised, mount-once
 * surfaces (dashboard widgets, report cards/panels).
 */
import { type ElementType, type HTMLAttributes, type ReactNode } from 'react';
import { cn } from '@/lib/utils';
import { useReducedMotion, type MediaQueryProvider } from './useReducedMotion';
import { useRevealOnScroll, revealStaggerMs, type IntersectionObserverFactory } from './useRevealOnScroll';

export interface RevealProps extends HTMLAttributes<HTMLElement> {
  readonly children: ReactNode;
  /** Position within a group revealed together — cascades the entrance. Default 0. */
  readonly index?: number;
  /** Render as this element instead of a `<div>` (e.g. `"section"`), preserving semantics. */
  readonly as?: ElementType;
  /** Test seam: reduced-motion provider (defaults to the real `matchMedia`). */
  readonly motionProvider?: MediaQueryProvider;
  /** Test seam: IntersectionObserver factory (defaults to the real one, or `null`). */
  readonly observerFactory?: IntersectionObserverFactory | null;
}

export function Reveal({
  children,
  index = 0,
  as,
  className,
  style,
  motionProvider,
  observerFactory,
  ...rest
}: RevealProps) {
  const reduced = useReducedMotion(motionProvider);
  const { ref, revealed, armed } = useRevealOnScroll({ reduced, observerFactory });
  const Tag = (as ?? 'div') as ElementType;
  const delayMs = revealStaggerMs(index);

  return (
    <Tag
      ref={ref}
      className={cn(
        className,
        // Pending: held invisible until it scrolls into view. Only ever applied while armed,
        // so a reduced-motion / observer-less render is fully visible from the first paint.
        armed && !revealed && 'opacity-0',
        // Revealed: the shared `animate-rise` entrance (opacity + 6px lift) — reused, never a
        // second hand-rolled entrance animation.
        armed && revealed && 'animate-rise',
      )}
      // The per-item stagger is a delay value (not a raw easing/duration), matching the
      // dashboard tile cascade; only meaningful while rising. The global reduced-motion
      // catch-all zeroes animation-delay, and we never arm under reduced motion anyway.
      style={armed && revealed && delayMs ? { ...style, animationDelay: `${delayMs}ms` } : style}
      {...rest}
    >
      {children}
    </Tag>
  );
}
