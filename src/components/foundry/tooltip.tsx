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

/**
 * Foundry Tooltip (spec §2.4.1, §3) — a premium, glassmorphic tooltip whose body
 * is **rich Markdown**, deliberately replacing the browser's plain `title`
 * attribute everywhere in the app. Feature code imports this from the Foundry, not
 * a third-party tooltip library.
 *
 * Behaviour: shows on hover and keyboard focus; stays open while the pointer is
 * over the bubble (so Markdown links are reachable); closes on Escape, blur, or
 * pointer-leave. It is portaled to <body> and positioned with viewport clamping so
 * it is never clipped by an overflow container.
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
}

const GAP = 8;
const CLOSE_DELAY_MS = 120;

export function Tooltip({
  content,
  children,
  placement = 'top',
  className,
  triggerTabIndex = 0,
}: TooltipProps) {
  const [open, setOpen] = useState(false);
  const [coords, setCoords] = useState<{ top: number; left: number } | null>(null);
  const triggerRef = useRef<HTMLSpanElement>(null);
  const tooltipRef = useRef<HTMLDivElement>(null);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const id = useId();

  const cancelClose = useCallback(() => {
    if (closeTimer.current !== null) {
      clearTimeout(closeTimer.current);
      closeTimer.current = null;
    }
  }, []);

  const show = useCallback(() => {
    cancelClose();
    setOpen(true);
  }, [cancelClose]);

  const scheduleClose = useCallback(() => {
    cancelClose();
    closeTimer.current = setTimeout(() => setOpen(false), CLOSE_DELAY_MS);
  }, [cancelClose]);

  useEffect(() => cancelClose, [cancelClose]);

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
  // Mouse taps are ignored here — hover already governs them.
  const onPointerDown = useCallback((e: ReactPointerEvent) => {
    if (e.pointerType === 'mouse') return;
    setOpen((prev) => !prev);
  }, []);

  return (
    <>
      <span
        ref={triggerRef}
        tabIndex={triggerTabIndex}
        aria-describedby={open ? id : undefined}
        onMouseEnter={show}
        onMouseLeave={scheduleClose}
        onFocus={show}
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
              className="z-[60] max-w-xs rounded-xl border border-border bg-popover/95 p-3 shadow-2xl shadow-black/40 backdrop-blur-xl animate-fade-in"
            >
              <Markdown content={content} />
            </div>,
            document.body,
          )
        : null}
    </>
  );
}
