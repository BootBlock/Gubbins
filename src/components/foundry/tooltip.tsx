import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type MouseEvent as ReactMouseEvent,
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
 * Behaviour: opens on **mouse** hover after a short delay (so it never flashes up the
 * instant the pointer crosses a trigger) and immediately on keyboard focus; stays open
 * while the pointer is over the bubble (so Markdown links are reachable); closes on
 * Escape, blur, or pointer-leave. It is portaled to <body> and positioned with viewport
 * clamping so it is never clipped by an overflow container.
 *
 * Touch has no hover, so hover-open is suppressed for touch/pen (a synthesised
 * `mouseenter` after a tap must never pop a bubble over the control the finger just
 * pressed). A tap opens the tooltip only on a *passive* trigger whose sole purpose is
 * the help — see {@link TooltipProps.openOnTap}. A trigger that wraps its own control
 * instead surfaces its help on touch via a **long-press-to-peek** ({@link LONG_PRESS_MS})
 * that opens the bubble without activating the control — the standard Material pattern.
 */
export type TooltipPlacement = 'top' | 'bottom' | 'left' | 'right';

/**
 * Bubble width tier. `sm` (default) suits a sentence or two of help; step up to
 * `md`/`lg` for richer content — a Markdown table, a code sample, or a longer
 * documentation panel that reads better with room to breathe.
 */
export type TooltipSize = 'sm' | 'md' | 'lg';

// `sm` hugs its content (a ceiling it rarely reaches — right for a sentence of help).
// `md`/`lg` take a *firm* width instead, so richer content (a table, a code block) is
// given real room rather than being squeezed to the width of the intro line above it.
// Each is clamped to the viewport so it never overflows a narrow screen.
const SIZE_MAX_WIDTH: Record<TooltipSize, string> = {
  sm: 'max-w-xs',
  md: 'w-[22rem] max-w-[calc(100vw-1rem)]',
  lg: 'w-[28rem] max-w-[calc(100vw-1rem)]',
};

export interface TooltipProps {
  /** Markdown string rendered inside the tooltip. */
  readonly content: string;
  readonly children: ReactNode;
  readonly placement?: TooltipPlacement;
  /** Class applied to the inline trigger wrapper. */
  readonly className?: string;
  /**
   * Maximum bubble width tier (default `sm`). Widen to `md`/`lg` for content that needs
   * it — tables, code blocks, or longer documentation. Tall content always scrolls
   * vertically within the bubble regardless of size.
   */
  readonly size?: TooltipSize;
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
  /**
   * Whether a **touch tap** on the trigger opens the tooltip. Touch has no hover, so a tap
   * is the only gesture available — but on a trigger that *wraps its own interactive control*
   * (a button, toggle, link…), popping the bubble on tap covers that control and swallows the
   * tap, so the control never fires. That is the wrong behaviour for the common case.
   *
   * Left undefined (the default), this is **auto-detected**: a trigger that contains an
   * interactive descendant is treated as a control wrapper (tap flows through to the control,
   * tooltip stays shut on touch), while a *passive* trigger — an `i` badge or a status pill
   * whose sole purpose is the tooltip — toggles open on tap so its help is reachable on touch.
   *
   * On an auto-detected **control wrapper**, the help is instead reachable via a
   * **long-press-to-peek** ({@link LONG_PRESS_MS}): a held touch/pen press opens the bubble
   * without firing the control. This prop is also the escape hatch for that gesture —
   * `openOnTap={false}` silences the trigger on touch entirely (**no** tap-open *and* no
   * long-press-peek), which is what a control that grows its *own* long-press behaviour
   * (e.g. long-press-to-multiselect) should pass. `openOnTap={true}` forces the plain
   * tap-toggle (so long-press-peek is moot). Pass an explicit value only to override the
   * auto-detection for an unusual trigger.
   */
  readonly openOnTap?: boolean;
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
/**
 * Hold duration (ms) before a touch/pen press on a *control-wrapping* trigger peeks its
 * tooltip. 500ms matches the platform long-press timeouts (Android `getLongPressTimeout()`,
 * iOS `minimumPressDuration`) so the gesture feels native, and sits comfortably above a
 * normal — even a slow — tap, so releasing late never accidentally peeks. See the touch
 * branch of `onPointerDown`.
 *
 * @internal Exported for unit tests only.
 */
export const LONG_PRESS_MS = 500;
/**
 * Movement tolerance (px) for the long-press-peek: if the pointer travels past this before
 * {@link LONG_PRESS_MS} elapses the press is cancelled — the gesture was a scroll or drag,
 * not a deliberate peek. Compared as a squared distance to avoid a `Math.sqrt` per move.
 */
const MOVE_CANCEL_PX = 10;
/**
 * Elements that count as the trigger "wrapping its own interactive control" for touch-tap
 * auto-detection (see {@link TooltipProps.openOnTap}). When a trigger contains one of these,
 * a tap belongs to that control, so the tooltip must not toggle open and cover it. A passive
 * trigger — an `i` badge or a status pill with none of these — toggles open on tap instead.
 */
const INTERACTIVE_TRIGGER_SELECTOR =
  'a[href], button, input, select, textarea, [role="button"], [role="radio"], [role="checkbox"], [role="switch"], [role="menuitem"], [role="tab"], [contenteditable="true"]';
/**
 * Height (px) of the soft fade drawn at a *scrollable* edge of the content region, so it is
 * visually obvious there is more to scroll. On a translucent glass panel a shadow overlay
 * can't work (there is no solid surface to cast onto), so we instead fade the content itself
 * to transparent with a `mask-image` — background-agnostic, and it simply melts the text into
 * the frosted pane behind it. The opaque stop is white (not black) so the mask reads the same
 * whether the engine treats it as alpha- or luminance-based.
 */
const SCROLL_FADE_PX = 20;

/**
 * Inline `mask-image` for the scroll region: fade the top and/or bottom edge to transparent
 * only where there is off-screen content. Returns `undefined` (no mask) when the content
 * fits, so a non-scrolling tooltip is never masked. See {@link SCROLL_FADE_PX}.
 */
function edgeFadeMaskStyle(edgeFade: { top: boolean; bottom: boolean }): CSSProperties | undefined {
  if (!edgeFade.top && !edgeFade.bottom) return undefined;
  // `white` vs `transparent` is a pure alpha stencil (never a rendered colour), so no design
  // token applies — white is the opaque stop; see {@link SCROLL_FADE_PX} for why not black.
  const start = edgeFade.top ? 'transparent' : 'white';
  const end = edgeFade.bottom ? 'transparent' : 'white';
  const mask = `linear-gradient(to bottom, ${start}, white ${SCROLL_FADE_PX}px, white calc(100% - ${SCROLL_FADE_PX}px), ${end})`;
  return { maskImage: mask, WebkitMaskImage: mask };
}

export function Tooltip({
  content,
  children,
  placement = 'top',
  className,
  size = 'sm',
  triggerTabIndex = 0,
  openDelayMs = DEFAULT_OPEN_DELAY_MS,
  openOnTap,
}: TooltipProps) {
  const [open, setOpen] = useState(false);
  const [coords, setCoords] = useState<{ top: number; left: number } | null>(null);
  const [edgeFade, setEdgeFade] = useState({ top: false, bottom: false });
  const reducedMotion = useReducedMotion();
  const triggerRef = useRef<HTMLSpanElement>(null);
  const tooltipRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const openTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Whether the most recent global input was a pointer press rather than a keypress. Consulted
  // by `onFocus` so the tooltip opens only on *keyboard* focus: a focus caused by a pointer —
  // a click/tap on the trigger, or focus restored to it when a dialog opened by a tap/click is
  // dismissed (issue #474) — must not pop the bubble. Tracked at document level (below) because
  // the input can land anywhere, not just on this trigger; `false` (keyboard) by default so a
  // trigger keyboard-focused right after mount still opens.
  const lastInputWasPointer = useRef(false);
  // Long-press-to-peek state (touch/pen on a control-wrapping trigger). `pressTimer`
  // is the pending peek; `pressStart` is the down point for the movement-cancel; and
  // `longPressFired` is a one-shot guard read by `onClickCapture` to swallow the click
  // synthesised on release, so the peek never also activates the underlying control.
  const pressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pressStart = useRef<{ x: number; y: number } | null>(null);
  const longPressFired = useRef(false);
  // Mouse hover-open is *armed* on enter (at the enter coordinates) and only promoted to a
  // delayed open once the cursor genuinely **moves** to a different point over the trigger. The
  // browser also synthesises an enter — and sometimes a zero-distance move — when the trigger
  // merely *appears* under a stationary cursor: e.g. a dialog opened by a touch tap closing,
  // leaving the OS cursor parked on the control the finger pressed (issue #474). Requiring an
  // actual positional change keeps the bubble shut for that, while still opening the instant the
  // user moves a real mouse onto the control (even one previously parked there). `null` = not
  // armed; an object = armed at that point.
  const hoverOpenPending = useRef<{ x: number; y: number } | null>(null);
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

  /** Disarm a pending long-press-peek (early release, movement, cancel, or unmount). */
  const cancelPress = useCallback(() => {
    if (pressTimer.current !== null) {
      clearTimeout(pressTimer.current);
      pressTimer.current = null;
    }
    pressStart.current = null;
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

  // Track the last global input modality so `onFocus` can open only on keyboard focus. A
  // pointer press (mouse or touch) marks pointer; a keypress marks keyboard. Capture-phase
  // document listeners see the input wherever it lands — including the click/tap that opens a
  // dialog, so the focus restored when that dialog closes is still recognised as pointer-driven
  // and never pops the bubble (issue #474).
  useEffect(() => {
    const markPointer = () => {
      lastInputWasPointer.current = true;
    };
    const markKeyboard = () => {
      lastInputWasPointer.current = false;
    };
    document.addEventListener('pointerdown', markPointer, true);
    document.addEventListener('keydown', markKeyboard, true);
    return () => {
      document.removeEventListener('pointerdown', markPointer, true);
      document.removeEventListener('keydown', markKeyboard, true);
    };
  }, []);

  useEffect(
    () => () => {
      cancelOpen();
      cancelClose();
      cancelPress();
    },
    [cancelOpen, cancelClose, cancelPress],
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

  // Track whether the content region is scrolled away from its top/bottom edge, so the
  // scroll-fade mask (below) only appears on the edge that actually has hidden content.
  const updateEdgeFade = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const scrollable = el.scrollHeight - el.clientHeight > 1;
    const top = scrollable && el.scrollTop > 1;
    const bottom = scrollable && el.scrollTop + el.clientHeight < el.scrollHeight - 1;
    // Bail out when the edges are unchanged (the common case while scrolling within a region),
    // so a scroll gesture doesn't re-render the tooltip — and re-parse its Markdown — every tick.
    setEdgeFade((prev) => (prev.top === top && prev.bottom === bottom ? prev : { top, bottom }));
  }, []);

  // Re-measure the fade edges when the tooltip opens, its content changes, or the viewport
  // resizes (which can change the clamped max-height). Scrolling within is handled by the
  // region's own onScroll.
  useLayoutEffect(() => {
    if (!open) {
      setEdgeFade({ top: false, bottom: false });
      return;
    }
    updateEdgeFade();
    window.addEventListener('resize', updateEdgeFade);
    return () => window.removeEventListener('resize', updateEdgeFade);
  }, [open, content, updateEdgeFade]);

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

  // Mouse hover governs open/close for a pointer that can hover. Touch and pen are
  // deliberately excluded: they have no true hover, and the browser synthesises a
  // `pointerenter`/`mouseenter` on a tap — acting on that would pop the bubble over the
  // control the finger just pressed (the reported touch bug). Tap handling lives in
  // `onPointerDown` instead.
  //
  // A mouse enter is *armed* (at its coordinates) rather than opened outright: the browser also
  // synthesises one when the trigger simply appears under a stationary cursor — e.g. a dialog
  // opened by a touch tap closing again, leaving the OS cursor parked on the control the finger
  // pressed (issue #474). The actual open is deferred to the first genuine move to a *different*
  // point over the trigger (`onPointerMove`), which a stationary cursor never produces.
  // `cancelClose` still runs so re-entering from the bubble keeps it open.
  const onPointerEnter = useCallback(
    (e: ReactPointerEvent) => {
      if (e.pointerType !== 'mouse') return;
      cancelClose();
      hoverOpenPending.current = { x: e.clientX, y: e.clientY };
    },
    [cancelClose],
  );
  const onPointerLeave = useCallback(
    (e: ReactPointerEvent) => {
      if (e.pointerType !== 'mouse') return;
      hoverOpenPending.current = null;
      scheduleClose();
    },
    [scheduleClose],
  );

  // Touch/pen: there is no hover, so a tap is the only way to reach the help. But a tap on a
  // trigger that wraps its own interactive control belongs to that control — opening the
  // bubble would cover it and swallow the tap — so only a *passive* trigger (an `i` badge, a
  // status pill) toggles on tap. A control-wrapping trigger instead peeks its help on a
  // **long-press** ({@link LONG_PRESS_MS}), which opens the bubble without firing the control.
  // `openOnTap` overrides this per-trigger; when unset it is auto-detected from whether the
  // trigger contains an interactive descendant. Mouse taps are ignored here (hover governs
  // them). The focus this press triggers is kept from opening the bubble by the document-level
  // input-modality tracking above, which marks the press as pointer-driven.
  const onPointerDown = useCallback(
    (e: ReactPointerEvent) => {
      // Reset the one-shot click guard at the start of every gesture, so a stale peek that
      // never got its synthesised click can't later swallow a genuine click.
      longPressFired.current = false;
      if (e.pointerType === 'mouse') return;
      const isControlWrapper = triggerRef.current?.querySelector(INTERACTIVE_TRIGGER_SELECTOR) != null;
      const tapOpens = openOnTap ?? !isControlWrapper;
      if (tapOpens) {
        setOpen((prev) => !prev);
        return;
      }
      // Not a tap-open trigger. An explicit `openOnTap={false}` silences it entirely (the
      // escape hatch); otherwise it's an auto-detected control wrapper, so arm the peek.
      if (openOnTap === false) return;
      cancelPress();
      pressStart.current = { x: e.clientX, y: e.clientY };
      pressTimer.current = setTimeout(() => {
        pressTimer.current = null;
        // Mark the peek so the ensuing synthesised `click` is swallowed (onClickCapture),
        // then open the bubble without activating the underlying control.
        longPressFired.current = true;
        show();
      }, LONG_PRESS_MS);
    },
    [openOnTap, cancelPress, show],
  );

  const onPointerMove = useCallback(
    (e: ReactPointerEvent) => {
      // Mouse: a move to a *different* point over an armed trigger confirms a real hover, so
      // promote it to the delayed open. A stationary synthetic enter (issue #474) yields no
      // move, or at most a zero-distance one, so the bubble stays shut. Once promoted the arm is
      // cleared, so continuous mouse jitter never re-defers the open.
      if (e.pointerType === 'mouse') {
        const armed = hoverOpenPending.current;
        if (armed && (e.clientX !== armed.x || e.clientY !== armed.y)) {
          hoverOpenPending.current = null;
          openWithDelay();
        }
        return;
      }
      // Touch/pen: movement past a small threshold cancels an armed long-press-peek — the
      // gesture is a scroll/drag, not a deliberate hold, so let the control keep the touch.
      // (pointer-up before the timer and pointer-cancel likewise disarm it — see the trigger
      // wiring below.)
      if (pressTimer.current === null || pressStart.current === null) return;
      const dx = e.clientX - pressStart.current.x;
      const dy = e.clientY - pressStart.current.y;
      if (dx * dx + dy * dy > MOVE_CANCEL_PX * MOVE_CANCEL_PX) cancelPress();
    },
    [openWithDelay, cancelPress],
  );

  // One-shot capture guard: when a long-press has just peeked, swallow the `click` that the
  // browser synthesises on release so the underlying control never fires. Capture-phase +
  // stopPropagation halts it before it reaches the control's own handler.
  const onClickCapture = useCallback((e: ReactMouseEvent) => {
    if (!longPressFired.current) return;
    e.preventDefault();
    e.stopPropagation();
    longPressFired.current = false;
  }, []);

  // Suppress the OS long-press context menu while a peek is pending/held, so the native
  // callout doesn't fight the tooltip. Gated on `pressStart` so a mouse right-click (which
  // never arms a press) keeps its context menu.
  const onContextMenu = useCallback((e: ReactMouseEvent) => {
    if (pressStart.current !== null) e.preventDefault();
  }, []);

  // Open on focus **only when it came from the keyboard**. A focus triggered by a pointer is
  // skipped: hover (mouse) or the tap-toggle / long-press-peek (touch) already governs
  // visibility, and force-opening here would render the bubble over the trigger — on mouse
  // stealing the mouse-up so the click never lands, and on touch popping the bubble on a plain
  // tap. This also covers focus **restored** to the trigger when a dialog opened by a tap/click
  // is dismissed (issue #474): that restoration follows a pointer interaction, so the modality
  // tracker still reads pointer and the bubble stays shut. Only genuine keyboard focus opens it.
  const onFocus = useCallback(() => {
    if (lastInputWasPointer.current) return;
    show();
  }, [show]);

  return (
    <>
      <span
        ref={triggerRef}
        tabIndex={triggerTabIndex}
        aria-describedby={open ? id : undefined}
        onPointerEnter={onPointerEnter}
        onPointerLeave={onPointerLeave}
        onFocus={onFocus}
        onBlur={scheduleClose}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={cancelPress}
        onPointerCancel={cancelPress}
        onClickCapture={onClickCapture}
        onContextMenu={onContextMenu}
        // `select-none` + `-webkit-touch-callout:none` stop the OS text-selection and
        // callout from hijacking a long-press-peek (see `onPointerDown`).
        className={cn('inline-flex select-none outline-none [-webkit-touch-callout:none]', className)}
      >
        {children}
      </span>

      {open
        ? createPortal(
            <div
              ref={tooltipRef}
              role="tooltip"
              id={id}
              onPointerEnter={(e) => {
                if (e.pointerType === 'mouse') show();
              }}
              onPointerLeave={(e) => {
                if (e.pointerType === 'mouse') scheduleClose();
              }}
              style={{
                position: 'fixed',
                top: coords?.top ?? 0,
                left: coords?.left ?? 0,
                visibility: coords ? 'visible' : 'hidden',
              }}
              className={cn(
                // Frosted-glass panel: a *translucent* popover surface (low alpha, so the
                // content behind genuinely blurs through) sat behind a heavy blur + saturation +
                // brightness lift, finished with a top-left specular `sheen` gradient and a
                // hairline inset highlight so it reads as a pane catching light rather than a
                // flat dark box. `overflow-hidden` clips the sheen + scroll region to the
                // rounded corners.
                'z-[60] overflow-hidden rounded-xl border border-border bg-popover/35 shadow-2xl shadow-black/40 ring-1 ring-inset ring-foreground/10 backdrop-blur-2xl backdrop-saturate-150 backdrop-brightness-110',
                'before:pointer-events-none before:absolute before:inset-0 before:bg-gradient-to-br before:from-glass-sheen before:to-transparent',
                SIZE_MAX_WIDTH[size],
                !reducedMotion && 'animate-fade-in',
              )}
            >
              {/* Tall content scrolls vertically within the bubble rather than overflowing the
                  viewport — the tooltip doubles as a documentation panel, so long help stays
                  readable. `relative` lifts it above the sheen ::before; padding lives here (not
                  on the glass panel) so the scrollbar tucks inside the rounded, clipped edge. The
                  mask fades content into the pane at any edge with more to scroll (see
                  {@link SCROLL_FADE_PX}). */}
              <div
                ref={scrollRef}
                onScroll={updateEdgeFade}
                style={edgeFadeMaskStyle(edgeFade)}
                className="relative max-h-[min(70vh,28rem)] overflow-y-auto p-3"
              >
                <Markdown content={content} />
              </div>
            </div>,
            document.body,
          )
        : null}
    </>
  );
}
