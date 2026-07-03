import { useLayoutEffect, useRef, useState, type CSSProperties, type RefObject } from 'react';

/**
 * Position a listbox popover in a `document.body` portal, anchored to a trigger.
 *
 * The combobox popovers ({@link Select}, {@link Autocomplete}) used to render as
 * `position: absolute` children of the trigger. Inside a scrolling dialog
 * (`.dialog-scroll` sets `overflow-y: auto`) that clips the popover to the scroll box —
 * and no `z-index` can escape an `overflow` clip. Rendering the popover in a portal with
 * `position: fixed`, positioned from the trigger's viewport rect, lifts it out of every
 * clipping ancestor so it draws over the dialog in full.
 *
 * The returned `style` matches the trigger's width, sits just below it (or flips above
 * when there is more room there), and caps its height to the available space. Position is
 * recomputed on scroll (capture phase, so scrolls in any ancestor count) and on resize.
 * `popoverRef` must be attached to the portalled element so callers can treat a click
 * inside it as "inside the control" when dismissing on outside-pointer.
 */
export function useAnchoredPopover(
  anchorRef: RefObject<HTMLElement | null>,
  open: boolean,
): { popoverRef: RefObject<HTMLDivElement | null>; style: CSSProperties | undefined } {
  const popoverRef = useRef<HTMLDivElement>(null);
  const [style, setStyle] = useState<CSSProperties | undefined>();

  useLayoutEffect(() => {
    if (!open) {
      setStyle(undefined);
      return;
    }
    const anchor = anchorRef.current;
    if (!anchor) return;

    const GAP = 4;
    const MAX_HEIGHT = 240; // mirrors the previous max-h-60
    const compute = () => {
      const rect = anchor.getBoundingClientRect();
      const spaceBelow = window.innerHeight - rect.bottom - GAP;
      const spaceAbove = rect.top - GAP;
      // Flip above only when below is genuinely cramped and above has more room.
      const placeAbove = spaceBelow < 160 && spaceAbove > spaceBelow;
      const maxHeight = Math.max(80, Math.min(MAX_HEIGHT, placeAbove ? spaceAbove : spaceBelow));
      setStyle({
        position: 'fixed',
        left: rect.left,
        width: rect.width,
        maxHeight,
        ...(placeAbove ? { bottom: window.innerHeight - rect.top + GAP } : { top: rect.bottom + GAP }),
      });
    };

    compute();
    // Capture-phase scroll so a scroll in the dialog body (not just the window) repositions.
    window.addEventListener('scroll', compute, true);
    window.addEventListener('resize', compute);
    return () => {
      window.removeEventListener('scroll', compute, true);
      window.removeEventListener('resize', compute);
    };
  }, [open, anchorRef]);

  return { popoverRef, style };
}
