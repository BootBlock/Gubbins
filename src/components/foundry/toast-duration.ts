/**
 * Reading-time-based auto-dismiss delay for a passive toast.
 *
 * A single fixed delay is wrong for a wall of text: a long message can vanish before it
 * has been read, while a two-word confirmation lingers longer than it needs to (issue
 * #77). Instead the delay scales with how much there is to read — an estimate derived
 * from the toast's visible character count, clamped to a comfortable floor and ceiling.
 *
 * Kept as a pure, React-light module so the estimate is unit-testable in isolation.
 */
import { Children, isValidElement, type ReactNode } from 'react';

/** Floor — short toasts keep the familiar ~5s dwell. */
export const TOAST_MIN_DURATION_MS = 5000;
/**
 * Ceiling — even a very long toast auto-dismisses within this so the viewport never
 * fills up with lingering notifications; the message is still readable while it shows.
 */
export const TOAST_MAX_DURATION_MS = 15000;
/**
 * Per-character reading budget. ~50ms/char ≈ 20 chars/s ≈ ~240 wpm at ~5 chars/word —
 * a relaxed glance-and-read pace rather than a focused-prose one, since a toast is a
 * peripheral interruption competing for attention.
 */
export const TOAST_MS_PER_CHAR = 50;

/**
 * Count the characters in a toast's visible text. Toast headings and messages are
 * arbitrary {@link ReactNode}s, so walk the tree and sum the length of every string /
 * number leaf, descending into element children. Non-text nodes (icons, `null`,
 * booleans) contribute nothing.
 */
export function reactNodeTextLength(node: ReactNode): number {
  let total = 0;
  Children.forEach(node, (child) => {
    if (child == null || typeof child === 'boolean') return;
    if (typeof child === 'string') {
      total += child.length;
      return;
    }
    if (typeof child === 'number') {
      total += String(child).length;
      return;
    }
    if (isValidElement(child)) {
      total += reactNodeTextLength((child.props as { children?: ReactNode }).children);
    }
  });
  return total;
}

/**
 * Estimate a comfortable auto-dismiss delay (ms) for a toast whose visible text is
 * `charCount` characters long: a per-character reading budget on top of the floor,
 * clamped to `[MIN, MAX]`. Pure and deterministic.
 */
export function toastDurationForLength(charCount: number): number {
  const estimate = TOAST_MIN_DURATION_MS + Math.max(0, charCount) * TOAST_MS_PER_CHAR;
  return Math.min(TOAST_MAX_DURATION_MS, Math.max(TOAST_MIN_DURATION_MS, estimate));
}
