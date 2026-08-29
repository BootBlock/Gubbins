/**
 * useSlidingIndicator — the geometry behind a segmented control's *moving* selection pill.
 *
 * A segmented control that paints its background on whichever button happens to be selected
 * gives the eye nothing to follow: the old choice fades out, the new one fades in, and the
 * relationship between them is left to be inferred. Lifting that background out into a single
 * absolutely-positioned element and animating it between the options makes the change legible —
 * the selection travels from where it was to where it now is (issue #449).
 *
 * The hook owns only the measurement. It hands back the pixel `left`/`width` of the selected
 * option relative to the container, and the caller renders the pill however its own variant
 * wants. The transition itself is CSS (`.gubbins-sliding-indicator` in `styles/index.css`), so
 * the global `prefers-reduced-motion` catch-all neutralises it for free.
 *
 * `settled` is `false` for the first measured frame, and again for the frame after any
 * layout-driven re-measure. The caller applies the transition class only once settled, so the
 * pill *appears* at the selected option on mount instead of flying in from the container's left
 * edge, and follows a reflow or a font swap instantly rather than trailing a second behind it.
 *
 * Measurement is re-run when the selection changes, when the option count changes, and whenever
 * the container resizes (a layout reflow, a font swap, a longer label). Where the container has
 * not been laid out — jsdom, a hidden panel — the geometry stays `null` and the caller falls
 * back to painting the selected button directly.
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';

/**
 * The scale a uniform ancestor transform is applying, from the container's rect against its
 * layout width.
 *
 * `offsetWidth` is itself rounded to a whole pixel, so a container 400.4px wide reports a scale of
 * 1.001 with nothing transformed at all — dividing by that would hand back exactly the half-pixel
 * error the rects were measured to avoid. Only a deviation far larger than that rounding is taken
 * as a real transform: a Modal's entrance is 4% off, an order of magnitude clear of the noise.
 */
function ancestorScale(rectWidth: number, layoutWidth: number): number {
  if (layoutWidth <= 0) return 1;
  const scale = rectWidth / layoutWidth;
  return Math.abs(scale - 1) < 0.02 ? 1 : scale;
}

/** Pixels, to a hundredth — fine enough for sub-pixel placement, coarse enough to be stable. */
function roundToSubPixel(value: number): number {
  return Math.round(value * 100) / 100;
}

/** Where the pill sits, in pixels relative to the container's padding box. */
export interface IndicatorGeometry {
  readonly left: number;
  readonly width: number;
}

export interface SlidingIndicator<T extends HTMLElement> {
  /** Attach to the (positioned) element the options are laid out in. */
  readonly containerRef: (element: HTMLDivElement | null) => void;
  /** Attach to option `index`: `ref={registerOption(index)}`. */
  readonly registerOption: (index: number) => (element: T | null) => void;
  /** The selected option's box, or `null` while nothing has been measured. */
  readonly geometry: IndicatorGeometry | null;
  /** `false` on the first measured frame, so the pill can appear without sliding. */
  readonly settled: boolean;
}

/**
 * Track the selected option's box within a segmented control.
 *
 * @param selectedIndex Index of the selected option in the rendered order.
 * @param optionCount   How many options are rendered; a change re-measures.
 */
export function useSlidingIndicator<T extends HTMLElement>(
  selectedIndex: number,
  optionCount: number,
): SlidingIndicator<T> {
  const containerEl = useRef<HTMLDivElement | null>(null);
  const optionEls = useRef<(T | null)[]>([]);
  const [container, setContainer] = useState<HTMLDivElement | null>(null);
  const [geometry, setGeometry] = useState<IndicatorGeometry | null>(null);
  const geometryRef = useRef<IndicatorGeometry | null>(null);
  const [settled, setSettled] = useState(false);

  const containerRef = useCallback((element: HTMLDivElement | null) => {
    containerEl.current = element;
    // Mirrored into state as well as the ref: the ref alone would not re-run the
    // ResizeObserver effect when React attaches the node.
    setContainer(element);
  }, []);

  const registerOption = useCallback(
    (index: number) => (element: T | null) => {
      optionEls.current[index] = element;
    },
    [],
  );

  const measure = useCallback(
    (animated: boolean) => {
      const parent = containerEl.current;
      const option = optionEls.current[selectedIndex];
      if (!parent || !option) return;
      // Rects rather than `offsetLeft`/`offsetWidth`: those round to whole pixels, and a pill
      // half a pixel wider than the option it covers shows as a sliver of the wrong colour at
      // the option's edge. An unlaid-out tree reports a zero-width rect and is ignored rather
      // than parked as a zero-width pill.
      const optionRect = option.getBoundingClientRect();
      if (optionRect.width <= 0) return;
      const parentRect = parent.getBoundingClientRect();
      // A rect is the *transformed* box, and these controls open inside a Modal whose panel
      // animates in from `scale(0.96)` — so a mount-time measurement is 4% short, and the pill
      // would sit narrow and left of its option for as long as the selection stood. Dividing by
      // the container's own scale converts back to the local pixels the pill is positioned in. It
      // reads a uniform, axis-aligned scale — which is what the app's entrances use; a rotated
      // ancestor would report its bounding box, and no such ancestor wraps these controls.
      const scale = ancestorScale(parentRect.width, parent.offsetWidth);
      if (scale <= 0) return;
      // The pill is `absolute; left: 0` inside the container, so its origin is the container's
      // padding-box edge — one border-width inside the rect measured here.
      // Rounded to a hundredth of a pixel: sub-pixel accuracy is the point of measuring rects,
      // but the scale division leaves float noise that would otherwise write `43.99999999999999px`
      // into the style and defeat the unchanged-measurement check below.
      const left = roundToSubPixel((optionRect.left - parentRect.left) / scale - parent.clientLeft);
      const width = roundToSubPixel(optionRect.width / scale);
      // Mirrored in a ref as well as state so an unchanged measurement costs nothing: a resize
      // observer fires per frame during a drag, and most of those frames measure the same box.
      const previous = geometryRef.current;
      if (previous && previous.left === left && previous.width === width) return;
      geometryRef.current = { left, width };
      setGeometry(geometryRef.current);
      // A pill that moved because the *layout* moved must not be seen to travel: the segments
      // jumped, so the pill jumps with them. Only a change of selection is worth animating.
      if (!animated) setSettled(false);
    },
    [selectedIndex],
  );

  useLayoutEffect(() => {
    // Drop refs left behind by options that no longer render, so a later shrink cannot
    // measure a detached node.
    optionEls.current.length = optionCount;
    measure(true);
  }, [measure, optionCount]);

  useEffect(() => {
    if (!container || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => measure(false));
    observer.observe(container);
    return () => observer.disconnect();
  }, [container, measure]);

  // One frame of "measured but not yet animating", so the pill is painted in place on mount —
  // and again after a layout-driven re-measure — and only slides for a change of selection.
  useEffect(() => {
    if (!geometry || settled) return;
    const frame =
      typeof requestAnimationFrame === 'function' ? requestAnimationFrame(() => setSettled(true)) : null;
    if (frame === null) {
      setSettled(true);
      return;
    }
    return () => cancelAnimationFrame(frame);
  }, [geometry, settled]);

  return { containerRef, registerOption, geometry, settled };
}
