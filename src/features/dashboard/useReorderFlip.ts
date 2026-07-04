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
    const nodeList = nodes.current;

    // Cancel any glide still in flight before measuring: `getBoundingClientRect` includes the
    // live transform, so a reorder within the settle window (e.g. a held arrow key) would
    // otherwise sample a mid-animation position and glide from a wrong origin. Disabling the
    // transition first makes clearing the transform snap to the true position, not ease to it.
    nodeList.forEach((el) => {
      el.style.transition = 'none';
      el.style.transform = '';
    });

    const after = new Map<string, DOMRect>();
    nodeList.forEach((el, id) => after.set(id, el.getBoundingClientRect()));

    const before = prevRects.current;
    // Animate only a real rearrangement held within a sustained edit session — never the reflow
    // when the mode toggles (`active` flipped) or the first measurement (`before === null`). A
    // layout shift that doesn't change `orderKey` (a slow widget growing, a resize) isn't
    // re-baselined until the next order change — an acceptable cosmetic edge for a delight glide.
    const shouldAnimate = active && prevActive.current && prevKey.current !== orderKey && before !== null;

    nodeList.forEach((el, id) => {
      const from = shouldAnimate ? before.get(id) : undefined;
      const to = after.get(id);
      const dx = from && to ? from.left - to.left : 0;
      const dy = from && to ? from.top - to.top : 0;
      if (dx === 0 && dy === 0) {
        // Nothing to play — drop the temporary `transition: none` set above so it doesn't linger.
        el.style.transition = '';
        return;
      }
      // Invert: the transition is already `none`, so placing it back at its old spot is instant.
      el.style.transform = `translate(${dx}px, ${dy}px)`;
      // Play: next frame, release it to its real place on the emphasized easing token (referenced
      // via its CSS variable — not a raw cubic-bezier literal).
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

    prevRects.current = after;
    prevActive.current = active;
    prevKey.current = orderKey;
  }, [orderKey, active]);

  return register;
}
