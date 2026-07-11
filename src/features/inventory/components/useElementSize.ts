import { useCallback, useEffect, useState } from 'react';

/** The measured content-box size of an element, in CSS pixels. */
export interface ElementSize {
  readonly width: number;
  readonly height: number;
}

/**
 * Track an element's pixel size with a `ResizeObserver`. Returns a callback ref to attach to the
 * element and its current size (0×0 until first measured). The element is tracked in **state** (not
 * a plain ref) so a node that mounts after first render — or is swapped — still (re)attaches the
 * observer, mirroring the `setScrollEl` pattern in {@link ItemList}. Used by the treemap / location
 * map views, which need real pixel dimensions to lay their tiles out.
 */
export function useElementSize(): [(node: HTMLElement | null) => void, ElementSize] {
  const [size, setSize] = useState<ElementSize>({ width: 0, height: 0 });
  const [el, setEl] = useState<HTMLElement | null>(null);
  const ref = useCallback((node: HTMLElement | null) => setEl(node), []);

  useEffect(() => {
    if (!el) return;
    const measure = () => setSize({ width: el.clientWidth, height: el.clientHeight });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [el]);

  return [ref, size];
}
