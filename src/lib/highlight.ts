import { useEffect, useRef, useState } from 'react';
import { create } from 'zustand';

/**
 * Global "highlight target" service — a small, app-wide helper for drawing the
 * user's eye to a specific element after a navigation or state change.
 *
 * The problem it solves: when a system deep-links the user to a screen that shows
 * *many* similar things (e.g. the Alert centre's "View in inventory" jumping to one
 * item card in a long list), the user has no way to tell *which* one they were sent
 * to. This service lets any caller request that a target scroll into view and play a
 * brief call-to-attention flash.
 *
 * It is deliberately generic and **not** tied to any one feature:
 *  - Any element registers itself as a target with {@link useHighlightTarget},
 *    passing a stable key (an item id, a row id, …). It gets back a `ref` to attach
 *    and an `isHighlighted` flag to drive the flash class.
 *  - Any caller — an event handler, an effect — asks for that key to be highlighted
 *    via {@link requestHighlight} (or the store's `requestHighlight`).
 *
 * The request survives until a matching target consumes it, so it works even when
 * the target is not yet mounted at request time (a common case: the destination
 * screen mounts and renders its list only *after* the navigation). A safety TTL
 * clears an unconsumed request so it can never fire against an unrelated element that
 * happens to mount with the same key much later.
 */

/** How long the call-to-attention flash lasts (the brief asks for 3 seconds). */
export const HIGHLIGHT_DURATION_MS = 3000;

/**
 * How long an unconsumed highlight request lingers before it is auto-cleared. Long
 * enough for a destination screen to mount, fetch and render its target; short enough
 * that a never-rendered target can't flash against a coincidental later mount.
 */
const HIGHLIGHT_REQUEST_TTL_MS = 10_000;

interface HighlightState {
  /** The key of the element currently requested to flash, or `null` when idle. */
  readonly key: string | null;
  /**
   * Monotonically-increasing token bumped on every request, so asking for the *same*
   * key twice in a row still re-fires the flash on an already-mounted target.
   */
  readonly nonce: number;
  /** Request that the target registered under `key` scroll into view and flash. */
  readonly requestHighlight: (key: string) => void;
  /** Clear the pending request (called once a target has consumed it, or on TTL). */
  readonly clearHighlight: () => void;
}

let ttlTimer: ReturnType<typeof setTimeout> | undefined;

export const useHighlightStore = create<HighlightState>((set, get) => ({
  key: null,
  nonce: 0,
  requestHighlight: (key) => {
    if (ttlTimer) clearTimeout(ttlTimer);
    ttlTimer = setTimeout(() => get().clearHighlight(), HIGHLIGHT_REQUEST_TTL_MS);
    set((s) => ({ key, nonce: s.nonce + 1 }));
  },
  clearHighlight: () => {
    if (ttlTimer) clearTimeout(ttlTimer);
    ttlTimer = undefined;
    set({ key: null });
  },
}));

/**
 * Imperative entry point for callers outside React render (event handlers, plain
 * modules): request a highlight without needing the hook.
 */
export function requestHighlight(key: string): void {
  useHighlightStore.getState().requestHighlight(key);
}

/**
 * Register an element as a highlight target.
 *
 * @param key A stable identifier for this target (e.g. an item id). Pass `undefined`
 *            to opt out (the element is never highlighted).
 * @returns `ref` to attach to the element, and `isHighlighted` — true for
 *          {@link HIGHLIGHT_DURATION_MS} after a matching request, to drive the flash.
 *
 * On a matching request the element is scrolled to the centre of its scroll container
 * and the flash begins. Reduced-motion users get an instant scroll and a neutralised
 * flash via the global `prefers-reduced-motion` catch-all in the stylesheet.
 */
export function useHighlightTarget<T extends HTMLElement = HTMLElement>(
  key: string | undefined,
): { ref: React.RefObject<T | null>; isHighlighted: boolean } {
  const ref = useRef<T>(null);
  const activeKey = useHighlightStore((s) => s.key);
  const nonce = useHighlightStore((s) => s.nonce);
  const clearHighlight = useHighlightStore((s) => s.clearHighlight);
  // Bumping this (re)starts the timed flash; kept separate from the store so clearing
  // the request the moment we claim it never tears down the in-flight flash timer.
  const [flashToken, setFlashToken] = useState(0);
  const [isHighlighted, setIsHighlighted] = useState(false);

  // Detect a request aimed at this element, claim it, and scroll into view.
  useEffect(() => {
    if (!key || activeKey !== key) return;
    const el = ref.current;
    if (!el) return;
    // Claim the request so no other target (or a later re-mount) also fires.
    clearHighlight();
    el.scrollIntoView({ block: 'center', behavior: 'smooth' });
    setFlashToken((t) => t + 1);
    // `nonce` is a dep so re-requesting the same key re-runs this effect.
  }, [key, activeKey, nonce, clearHighlight]);

  // Drive the timed flash independently of the request lifecycle.
  useEffect(() => {
    if (flashToken === 0) return;
    setIsHighlighted(true);
    const timer = setTimeout(() => setIsHighlighted(false), HIGHLIGHT_DURATION_MS);
    return () => clearTimeout(timer);
  }, [flashToken]);

  return { ref, isHighlighted };
}
