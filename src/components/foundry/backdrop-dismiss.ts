/**
 * Backdrop dismissal — the "tap the dimmed area to close" gesture shared by the Foundry
 * dialog surfaces, {@link Modal} and {@link Drawer}.
 *
 * Tapping the backdrop is the gesture people reach for before hunting a close button, so it
 * has to work every time. A `click` handler on the backdrop alone does not: the browser
 * dispatches a click on the nearest common ancestor of the press and the release, so it only
 * reaches the backdrop when *both* ends of the gesture land there. Release a few pixels onto
 * the panel and the click goes to the dialog **container** instead — and on a phone the strip
 * of backdrop either side of the panel is barely a finger wide, so a tap there that rolls onto
 * the panel as the finger lifts silently did nothing (#614).
 *
 * The click was never missing, then, only aimed one level up. So the handler moves to the
 * container and the gesture is qualified by where it *began*: a click dismisses only if the
 * press behind it landed on the backdrop. A press that begins *inside* the panel never
 * dismisses however far it is dragged, which is what stops a text selection dragged out of a
 * field from closing the dialog it was being typed into.
 *
 * The dismissing click also has to be one a pointer actually made — `detail` counts the clicks
 * of a press, so it is `0` for the click Enter or Space synthesises on a focused control, and
 * for a programmatic `.click()`. Without that test a press the user abandoned would sit armed
 * (let go past the edge of the screen and no click ever arrives) until some unrelated keyboard
 * activation collected it and closed the dialog out of nowhere. A *pointer* click can never
 * collect a stale press, because its own press disarms it first.
 *
 * Staying with `click` rather than closing on the release directly is deliberate: it keeps the
 * dismissing click *inside* the dialog's own tree. Closing a frame earlier, on `pointerup`,
 * unmounts the dialog before the click is dispatched and the browser then delivers it to
 * whatever was behind the backdrop — so dismissing over a button pressed that button.
 */
import {
  useCallback,
  useRef,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
} from 'react';

export interface BackdropDismiss {
  /**
   * Attach to the backdrop element. It is what a press is tested against, so the backdrop
   * itself needs no handlers — it stays the decorative, non-interactive layer it looks like.
   */
  readonly backdropRef: RefObject<HTMLDivElement | null>;
  /**
   * Spread onto the dialog container. It spans the viewport and contains both the backdrop
   * and the panel, so it is where the browser dispatches the click of a gesture that started
   * on one and ended on the other.
   */
  readonly containerProps: {
    readonly onPointerDown: (e: ReactPointerEvent) => void;
    readonly onClick: (e: ReactMouseEvent) => void;
  };
}

/**
 * Wire backdrop-tap dismissal, calling `onClose` when the gesture qualifies.
 *
 * `onClose` is read through a ref so a call site can keep passing an inline closure without
 * re-creating the handlers on every render.
 */
export function useBackdropDismiss(onClose: () => void): BackdropDismiss {
  const backdropRef = useRef<HTMLDivElement>(null);
  /** Whether the press the next pointer click belongs to landed on the backdrop. */
  const pressedBackdropRef = useRef(false);

  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  const onPointerDown = useCallback((e: ReactPointerEvent) => {
    // A press anywhere but the backdrop — the panel, a control in it — disarms rather than
    // staying live, and a non-primary pointer never arms at all: it is the second finger of a
    // pinch, which the user is not aiming at anything. The button is not consulted, because a
    // right- or middle-press produces `contextmenu` / `auxclick` rather than the `click` this
    // waits for, and the primary press behind a real click always lands here first.
    pressedBackdropRef.current = e.isPrimary && e.target === backdropRef.current;
  }, []);

  const onClick = useCallback((e: ReactMouseEvent) => {
    const dismissing = pressedBackdropRef.current && e.detail > 0;
    pressedBackdropRef.current = false;
    if (dismissing) onCloseRef.current();
  }, []);

  return { backdropRef, containerProps: { onPointerDown, onClick } };
}
