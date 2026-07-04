/**
 * useReorderFlip — a small FLIP animation for a reorderable board (spec §3
 * "Micro-interactions & Delight").
 *
 * When a tile is dragged, arrow-keyed or pinned, the layout jumps to its new arrangement
 * instantly. This makes each affected tile *glide* from where it was to where it now is: the
 * classic **FLIP** technique — record each node's box (First), let React commit the new layout
 * (Last), apply the inverse transform so it appears not to have moved (Invert), then release it
 * to its real position on the signature `--ease-emphasized` easing (Play).
 *
 * Usage: spread `register(id)` as a `ref` on each reorderable element and pass an `orderKey`
 * that changes whenever the arrangement does (positions/order). Animation runs only on a
 * genuine reorder while `active` — not on the layout jump when edit mode turns on/off, nor on
 * first paint — and `active` should already fold in reduced-motion (pass `editing && !reduced`),
 * so reduced-motion users get the instant jump the global catch-all guarantees everywhere else.
 */
import { useCallback, useLayoutEffect, useRef } from 'react';

/** Settle duration for a reordered tile gliding to its new place. */
const FLIP_MS = 300;

export function useReorderFlip(
  orderKey: string,
  active: boolean,
): (id: string) => (el: HTMLElement | null) => void {
  const nodes = useRef(new Map<string, HTMLElement>());
  const prevRects = useRef<Map<string, DOMRect> | null>(null);
  const prevActive = useRef(active);
  const prevKey = useRef(orderKey);

  const register = useCallback(
    (id: string) => (el: HTMLElement | null) => {
      if (el) nodes.current.set(id, el);
      else nodes.current.delete(id);
    },
    [],
  );

  useLayoutEffect(() => {
    const after = new Map<string, DOMRect>();
    nodes.current.forEach((el, id) => after.set(id, el.getBoundingClientRect()));

    const before = prevRects.current;
    // Animate only a real rearrangement held within a sustained edit session — never the reflow
    // when the mode toggles (`active` flipped) or the first measurement (`before === null`).
    const shouldAnimate = active && prevActive.current && prevKey.current !== orderKey && before !== null;

    if (shouldAnimate) {
      nodes.current.forEach((el, id) => {
        const from = before.get(id);
        const to = after.get(id);
        if (!from || !to) return;
        const dx = from.left - to.left;
        const dy = from.top - to.top;
        if (dx === 0 && dy === 0) return;
        // Invert: snap the node back to where it was, with no transition.
        el.style.transition = 'none';
        el.style.transform = `translate(${dx}px, ${dy}px)`;
        // Play: on the next frame, release it to its real place on the emphasized easing token
        // (referenced via its CSS variable — not a raw cubic-bezier literal).
        requestAnimationFrame(() => {
          el.style.transition = `transform ${FLIP_MS}ms var(--ease-emphasized)`;
          el.style.transform = '';
          const clear = () => {
            el.style.transition = '';
            el.style.transform = '';
            el.removeEventListener('transitionend', clear);
          };
          el.addEventListener('transitionend', clear);
        });
      });
    }

    prevRects.current = after;
    prevActive.current = active;
    prevKey.current = orderKey;
  }, [orderKey, active]);

  return register;
}
