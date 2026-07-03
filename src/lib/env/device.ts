/**
 * Large-format device detection (spec §2.4.2 canonical page frame; §3 adaptive layout).
 *
 * The whole app is centred inside a single fixed-width {@link PageContainer}
 * (`max-w-6xl`). That cap is right for standard phones and laptops, but it leaves a
 * *large-format* touch device — a tablet, or a foldable like the Pixel Fold unfolded —
 * showing a narrow column marooned in a sea of empty margin. This module is the JS seam
 * (mirroring `motion.ts`'s reduced-motion seam) that identifies those devices so the
 * layout can reclaim the extra room, while everything else keeps the current frame.
 *
 * ## Why *this* query — and why not just width
 *
 * A desktop monitor and a tablet can report the same CSS width, so width alone can't
 * tell "big touch slate" from "ordinary desktop". The discriminating signals are:
 *
 * - `(pointer: coarse)` — the primary input is touch, not a mouse. This is what
 *   separates a tablet/foldable from a same-width laptop (which is `pointer: fine`),
 *   so widening the frame never touches a standard desktop.
 * - `(min-width: 768px)` — excludes ordinary phones (which stay on the current layout)
 *   and a foldable while *folded* (its outer screen is phone-sized).
 * - `(min-height: 600px)` — excludes a large phone held in **landscape** (short height),
 *   which would otherwise sneak past the width test; a real tablet/foldable is tall
 *   even in landscape.
 *
 * The grounded, modern guidance (2025) is: page-level layout switches like this one
 * belong in **media queries**, while component-internal reflow belongs in **container
 * queries** (`@container`, already used by the inventory grid via its `ResizeObserver`).
 * This constant is the single source of truth for the media query, mirrored 1:1 by the
 * `large-format:` Tailwind custom variant in `styles/index.css` so CSS and JS agree.
 */

/**
 * The media query that identifies a large-format touch device (tablet / unfolded
 * foldable). Kept identical to the `large-format:` custom variant in `styles/index.css`.
 */
export const LARGE_FORMAT_QUERY = '(min-width: 768px) and (min-height: 600px) and (pointer: coarse)';

/**
 * A foldable held open like a book — two side-by-side viewport segments with the hinge
 * between them (the Viewport Segments media feature; Edge stable, Chrome origin trial).
 * Used only as a progressive enhancement to keep content clear of the hinge; layout must
 * never *depend* on it, since most engines don't report it yet.
 */
export const FOLDABLE_BOOK_QUERY = '(horizontal-viewport-segments: 2)';

/**
 * Whether the current device is a large-format touch device. Feature-detected; defaults
 * to `false` (the standard frame) where `matchMedia` is unavailable — in that case the
 * CSS `large-format:` variant remains the authority, so nothing is lost.
 */
export function isLargeFormat(): boolean {
  if (typeof matchMedia !== 'function') return false;
  return matchMedia(LARGE_FORMAT_QUERY).matches;
}
