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
 * `large-format:` Tailwind custom variant in `styles/index.css` so CSS and JS agree. The two
 * are independent literals in two languages, so `device.test.ts` reads the stylesheet and
 * asserts they match — drift there is a build failure, not a bug that only shows up on one
 * real tablet.
 */

/**
 * The media query that identifies a large-format touch device (tablet / unfolded
 * foldable). Kept identical to the `large-format:` custom variant in `styles/index.css`.
 */
export const LARGE_FORMAT_QUERY = '(min-width: 768px) and (min-height: 600px) and (pointer: coarse)';

/**
 * The media query for a **compact** viewport — anything narrower than the tablet floor
 * {@link LARGE_FORMAT_QUERY} starts at, i.e. Tailwind's `md` breakpoint (48rem = 768px).
 * It is the exact complement of `md:`, so a screen either lays out its master-detail panes
 * side by side or it doesn't; there is no width at which both or neither apply.
 *
 * ## Why width alone — and why that isn't the `handset:` mistake
 *
 * The sibling `handset:` variant deliberately pairs its width test with `(pointer: coarse)`,
 * because a bare `max-width` cannot tell a phone from a desktop zoomed to 200% (both report
 * ~640 CSS px) and *hiding* content there would take it away from exactly the low-vision user
 * who zoomed in to read it (WCAG 1.4.4 Resize Text).
 *
 * This query is the other case: nothing is hidden. A master pane that doesn't fit beside the
 * detail pane moves into a drawer, one tap away and fully intact. That is **reflow**, which
 * WCAG 1.4.10 asks for at 320 CSS px on *every* device — so a zoomed desktop should get it too,
 * and adding `(pointer: coarse)` here would wrongly withhold it. Width is the whole question.
 */
export const COMPACT_LAYOUT_QUERY = '(width < 48rem)';

/**
 * The media query for a touch device — the primary input is a finger, not a mouse.
 *
 * It is the term `LARGE_FORMAT_QUERY` and the `handset:` variant both use to ask "is this real
 * touch hardware", and it is also the closest thing the platform offers to "is this a GPU that
 * cannot afford an expensive effect": no capability media feature exists, so the app leans on the
 * correlation. The weather layer's backing-store cap
 * ({@link import('@/components/background/device-tier').precipDprCap}) and the stylesheet's
 * `--backdrop-surface` block are that same decision taken in two languages, so `device.test.ts`
 * asserts the two still agree.
 */
export const COARSE_POINTER_QUERY = '(pointer: coarse)';

/**
 * The media query for a device whose primary input **cannot hover at all** — a phone or tablet,
 * but not a touchscreen laptop, whose mouse answers `hover: hover`. Kept identical to the
 * `touch:` custom variant in `styles/index.css`, which asks the same question in CSS; the parity
 * is asserted by `device.test.ts` rather than trusted to these two comments.
 *
 * Deliberately *not* `(pointer: coarse)` — see the variant's own note. Those ask "how precise is
 * the pointer", to size and lay things out; this asks "will a hover state ever be entered", which
 * is the question to ask before doing work that only a hover can make visible.
 */
export const HOVER_NONE_QUERY = '(hover: none)';

/**
 * A foldable held open like a book — two side-by-side viewport segments with the hinge
 * between them (the Viewport Segments media feature; Edge stable, Chrome origin trial).
 * Used only as a progressive enhancement to keep content clear of the hinge; layout must
 * never *depend* on it, since most engines don't report it yet.
 *
 * @internal Exported for unit tests only.
 */
export const FOLDABLE_BOOK_QUERY = '(horizontal-viewport-segments: 2)';

/**
 * Whether the current device is a large-format touch device. Feature-detected; defaults
 * to `false` (the standard frame) where `matchMedia` is unavailable — in that case the
 * CSS `large-format:` variant remains the authority, so nothing is lost.
 *
 * @internal Exported for unit tests only.
 */
export function isLargeFormat(): boolean {
  if (typeof matchMedia !== 'function') return false;
  return matchMedia(LARGE_FORMAT_QUERY).matches;
}
