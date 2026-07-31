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
 * container and the gesture is qualified by where it *began*: a click dismisses only when it
 * completes a pointer gesture — press, then release — that started on the backdrop. A press
 * that begins *inside* the panel never dismisses however far it is dragged, which is what
 * stops a text selection dragged out of a field from closing the dialog it was being typed
 * into.
 *
 * Requiring the release, not just the press, is what keeps an *abandoned* gesture from being
 * cashed in later: press the backdrop and let go outside the window and no click ever arrives,
 * so without it the dialog would stay armed and the next click to reach the container — an
 * Enter on a focused button, a form submit, anything not preceded by a press — would dismiss
 * it out of nowhere.
 *
 * Staying with `click` rather than closing on the release directly is deliberate: it keeps the
 * dismissing click *inside* the dialog's own tree. Closing a frame earlier, on `pointerup`,
 * unmounts the dialog before the click is dispatched and the browser then delivers it to
 * whatever was behind the backdrop — so dismissing over a button pressed that button.
 */
import { useCallback, useRef, type PointerEvent as ReactPointerEvent, type RefObject } from 'react';

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
    readonly onPointerUp: (e: ReactPointerEvent) => void;
    readonly onPointerCancel: (e: ReactPointerEvent) => void;
    readonly onClick: () => void;
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
  /** The in-flight gesture that began on the backdrop, and whether it has been released yet. */
  const gestureRef = useRef<{ readonly pointerId: number; readonly released: boolean } | null>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  const onPointerDown = useCallback((e: ReactPointerEvent) => {
    // Only a primary press of the primary button on the backdrop itself starts a dismissing
    // gesture: a non-primary pointer is the second finger of a pinch, and a right- or
    // middle-press produces a context menu rather than the click this waits for. A press
    // anywhere else — the panel, a control in it — discards any gesture still in flight rather
    // than letting it fire on an unrelated click.
    const dismissing = e.isPrimary && e.button === 0 && e.target === backdropRef.current;
    gestureRef.current = dismissing ? { pointerId: e.pointerId, released: false } : null;
  }, []);

  const onPointerUp = useCallback((e: ReactPointerEvent) => {
    // Wherever it lands — the release rolling onto the panel is the case that was broken.
    if (gestureRef.current?.pointerId === e.pointerId) {
      gestureRef.current = { pointerId: e.pointerId, released: true };
    }
  }, []);

  const onPointerCancel = useCallback((e: ReactPointerEvent) => {
    // The browser took the gesture over — a pinch, a pan it decided to own. Drop it, so a
    // stray release from another finger cannot complete it on this pointer's behalf.
    if (gestureRef.current?.pointerId === e.pointerId) gestureRef.current = null;
  }, []);

  const onClick = useCallback(() => {
    const completed = gestureRef.current?.released === true;
    gestureRef.current = null;
    if (completed) onCloseRef.current();
  }, []);

  return { backdropRef, containerProps: { onPointerDown, onPointerUp, onPointerCancel, onClick } };
}
