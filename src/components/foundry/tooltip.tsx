import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import { cn } from '@/lib/utils';
import { Markdown } from './markdown';
import { useReducedMotion } from './useReducedMotion';

/**
 * Foundry Tooltip (spec §2.4.1, §3) — a premium, glassmorphic tooltip whose body
 * is **rich Markdown**, deliberately replacing the browser's plain `title`
 * attribute everywhere in the app. Feature code imports this from the Foundry, not
 * a third-party tooltip library.
 *
 * Behaviour: opens on hover after a short delay (so it never flashes up the instant
 * the pointer crosses a trigger), and immediately on keyboard focus or touch tap;
 * stays open while the pointer is over the bubble (so Markdown links are reachable);
 * closes on Escape, blur, or pointer-leave. It is portaled to <body> and positioned
 * with viewport clamping so it is never clipped by an overflow container.
 */
export type TooltipPlacement = 'top' | 'bottom' | 'left' | 'right';

export interface TooltipProps {
  /** Markdown string rendered inside the tooltip. */
  readonly content: string;
  readonly children: ReactNode;
  readonly placement?: TooltipPlacement;
  /** Class applied to the inline trigger wrapper. */
  readonly className?: string;
  /**
   * Tab stop for the trigger wrapper. Defaults to 0 so standalone triggers (e.g.
   * an info glyph) are keyboard-focusable. Pass -1 when wrapping an already
   * focusable control to avoid a duplicate tab stop — focus events still bubble.
   */
  readonly triggerTabIndex?: number;
  /**
   * Hover dwell (ms) before the tooltip opens. Defaults to {@link DEFAULT_OPEN_DELAY_MS}
   * (1s) — the right feel for *controls*, where a tooltip is supplementary help that
   * shouldn't flash up as the pointer merely passes over a button. Pass {@link INFO_OPEN_DELAY_MS}
   * (300ms) for a deliberate `i` information badge, where the tooltip *is* the point of
   * the control and the user expects the help almost immediately.
   */
  readonly openDelayMs?: number;
}

const GAP = 8;
/**
 * Default hover dwell before a tooltip opens, so it never flashes on a passing
 * pointer. Tuned for *controls* (buttons, toggles, steppers): a full second, long
 * enough that brushing past a button never pops a bubble, but quick enough that a
 * genuine "what does this do?" hover is rewarded.
 */
export const DEFAULT_OPEN_DELAY_MS = 1000;
/**
 * Snappier dwell for deliberate `i` information badges, where the glyph exists
 * solely to surface help — the user is asking for it, so don't make them wait.
 */
export const INFO_OPEN_DELAY_MS = 300;
/**
 * Longer dwell for navigation controls that already carry a visible label — e.g. the
 * tabs of a dialog rail. Their tooltip is purely supplementary, so it should appear only
 * on a deliberate, lingering hover and never flash up as the pointer crosses the rail to
 * reach a tab. Slower than {@link DEFAULT_OPEN_DELAY_MS} for exactly that reason.
 */
export const NAV_OPEN_DELAY_MS = 1500;
const CLOSE_DELAY_MS = 120;

export function Tooltip({
  content,
  children,
  placement = 'top',
  className,
  triggerTabIndex = 0,
  openDelayMs = DEFAULT_OPEN_DELAY_MS,
}: TooltipProps) {
  const [open, setOpen] = useState(false);
  const [coords, setCoords] = useState<{ top: number; left: number } | null>(null);
  const reducedMotion = useReducedMotion();
  const triggerRef = useRef<HTMLSpanElement>(null);
  const tooltipRef = useRef<HTMLDivElement>(null);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const openTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // True for the brief window after a pointer press, so the focus it triggers does
  // not force the bubble open. See `onFocus` below.
  const pointerInitiatedFocus = useRef(false);
  const id = useId();

  const cancelClose = useCallback(() => {
    if (closeTimer.current !== null) {
      clearTimeout(closeTimer.current);
      closeTimer.current = null;
    }
  }, []);

  const cancelOpen = useCallback(() => {
    if (openTimer.current !== null) {
      clearTimeout(openTimer.current);
      openTimer.current = null;
    }
  }, []);

  /** Open immediately — for keyboard focus, touch tap, and re-entering the bubble. */
  const show = useCallback(() => {
    cancelOpen();
    cancelClose();
    setOpen(true);
  }, [cancelOpen, cancelClose]);

  /** Open after a hover dwell — cancelled if the pointer leaves first (scheduleClose). */
  const openWithDelay = useCallback(() => {
    cancelClose();
    if (openTimer.current !== null || open) return;
    openTimer.current = setTimeout(() => {
      openTimer.current = null;
      setOpen(true);
    }, openDelayMs);
  }, [cancelClose, open, openDelayMs]);

  const scheduleClose = useCallback(() => {
    cancelOpen();
    cancelClose();
    closeTimer.current = setTimeout(() => setOpen(false), CLOSE_DELAY_MS);
  }, [cancelOpen, cancelClose]);

  useEffect(
    () => () => {
      cancelOpen();
      cancelClose();
    },
    [cancelOpen, cancelClose],
  );

  // Position once open (and keep aligned on scroll/resize). Measured after the
  // bubble renders hidden, so getBoundingClientRect reflects its true size.
  useLayoutEffect(() => {
    if (!open) {
      setCoords(null);
      return;
    }
    const position = () => {
      const trigger = triggerRef.current?.getBoundingClientRect();
      const bubble = tooltipRef.current?.getBoundingClientRect();
      if (!trigger || !bubble) return;

      let top: number;
      let left: number;
      switch (placement) {
        case 'bottom':
          top = trigger.bottom + GAP;
          left = trigger.left + trigger.width / 2 - bubble.width / 2;
          break;
        case 'left':
          top = trigger.top + trigger.height / 2 - bubble.height / 2;
          left = trigger.left - bubble.width - GAP;
          break;
        case 'right':
          top = trigger.top + trigger.height / 2 - bubble.height / 2;
          left = trigger.right + GAP;
          break;
        default:
          top = trigger.top - bubble.height - GAP;
          left = trigger.left + trigger.width / 2 - bubble.width / 2;
      }
      // Clamp within the viewport so the bubble is never cut off.
      left = Math.max(GAP, Math.min(left, window.innerWidth - bubble.width - GAP));
      top = Math.max(GAP, Math.min(top, window.innerHeight - bubble.height - GAP));
      setCoords({ top, left });
    };

    position();
    window.addEventListener('scroll', position, true);
    window.addEventListener('resize', position);
    return () => {
      window.removeEventListener('scroll', position, true);
      window.removeEventListener('resize', position);
    };
  }, [open, placement, content]);

  // Escape closes the tooltip; a tap/click outside both the trigger and the bubble
  // closes it too (the dismissal path for touch, where there is no mouse-leave).
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    const onPointerDown = (e: PointerEvent) => {
      const target = e.target as Node | null;
      if (triggerRef.current?.contains(target) || tooltipRef.current?.contains(target)) return;
      setOpen(false);
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('pointerdown', onPointerDown);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('pointerdown', onPointerDown);
    };
  }, [open]);

  // Touch/pen: there is no hover, so tapping the trigger toggles the tooltip.
  // Mouse taps are ignored here — hover already governs them. Either way, flag that
  // the focus about to fire was pointer-initiated so `onFocus` doesn't also open.
  const onPointerDown = useCallback((e: ReactPointerEvent) => {
    pointerInitiatedFocus.current = true;
    // The focus event fires synchronously right after this; clear the flag once it
    // (and any same-tick re-focus) has passed, so a later keyboard focus still opens.
    setTimeout(() => {
      pointerInitiatedFocus.current = false;
    }, 0);
    if (e.pointerType === 'mouse') return;
    setOpen((prev) => !prev);
  }, []);

  // Open on focus **only when it came from the keyboard**. A focus triggered by a
  // pointer press is skipped: hover (mouse) or the tap-toggle (touch) already governs
  // visibility, and force-opening here would render the bubble over the trigger
  // between pointer-down and -up — stealing the mouse-up so the click never lands.
  const onFocus = useCallback(() => {
    if (pointerInitiatedFocus.current) return;
    show();
  }, [show]);

  return (
    <>
      <span
        ref={triggerRef}
        tabIndex={triggerTabIndex}
        aria-describedby={open ? id : undefined}
        onMouseEnter={openWithDelay}
        onMouseLeave={scheduleClose}
        onFocus={onFocus}
        onBlur={scheduleClose}
        onPointerDown={onPointerDown}
        className={cn('inline-flex outline-none', className)}
      >
        {children}
      </span>

      {open
        ? createPortal(
            <div
              ref={tooltipRef}
              role="tooltip"
              id={id}
              onMouseEnter={show}
              onMouseLeave={scheduleClose}
              style={{
                position: 'fixed',
                top: coords?.top ?? 0,
                left: coords?.left ?? 0,
                visibility: coords ? 'visible' : 'hidden',
              }}
              className={cn(
                'z-[60] max-w-xs rounded-xl border border-border bg-popover/95 p-3 shadow-2xl shadow-black/40 backdrop-blur-xl',
                !reducedMotion && 'animate-fade-in',
              )}
            >
              <Markdown content={content} />
            </div>,
            document.body,
          )
        : null}
    </>
  );
}
