/**
 * Shared chrome for a selectable option card — a tile the user picks from a set.
 *
 * Many features render such a card: the Modules manager grid and the first-run chooser
 * present the curated presets, the users screens present their own choices, and the export,
 * gauge-adjust, location and Home Assistant surfaces each offer a picked-from-a-set control.
 * Each uses different selection semantics (a multi-toggle `aria-pressed` button vs a
 * `role="radio"` vs an `aria-current="step"` chip) and different inner layouts. What they must
 * NOT let drift apart is the card's visual language — its base border/padding, its focus ring
 * and, crucially, the selected/unselected token pair — so a single retint stays consistent
 * across every surface. Because more than one feature composes it, that shared chrome belongs
 * in the Foundry rather than in any one feature; each call site adds its own layout and wires
 * its own interaction/ARIA on top.
 */
import { cn } from '@/lib/utils';

/**
 * How large the tile is. The selection tokens and the focus ring's width and colour are
 * identical across all of them — what a size varies is the box: its radius and padding,
 * because some of these controls are deliberately denser than a full card.
 */
export type OptionCardSize =
  /** A full card with room for a title and a line of hint text. */
  | 'card'
  /** A tighter card — the same shape, one step less padding. */
  | 'compact'
  /** A single-line chip, as in a horizontal step rail. */
  | 'chip'
  /**
   * A fixed-size icon swatch — small enough to sit shoulder-to-shoulder in a wrapping row.
   * The caller sets the box (e.g. `size-8`), so this adds no padding. Two things differ
   * from the larger sizes, both because the box is tiny:
   *
   * - the ring is offset, so it reads as a ring around the swatch rather than a thicker
   *   border, and stays consistent with the colour swatches these sit beside;
   * - the transition covers the growing a swatch signals selection with. That property is
   *   `scale`, not `transform` — Tailwind v4 compiles `scale-*` to the standalone `scale`
   *   property, so a transition listing only `transform` would leave the grow to snap.
   */
  | 'swatch';

const SIZE_CLASSES: Record<OptionCardSize, string> = {
  card: 'rounded-xl p-4',
  compact: 'rounded-xl p-3',
  chip: 'rounded-lg px-2.5 py-1.5',
  swatch:
    'rounded-lg transition-[color,background-color,border-color,scale] focus-visible:ring-offset-2 focus-visible:ring-offset-background',
};

/**
 * The base + selection-state classes for an option card. Callers `cn()` their own layout
 * (flex direction, gaps, icon sizing) on top. `active` picks the selected token pair, and
 * `size` picks the radius/padding for how dense this particular tile is.
 */
export function optionCardClassName(active: boolean, size: OptionCardSize = 'card'): string {
  return cn(
    'border text-left transition-colors duration-150 ease-emphasized outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:border-ring',
    SIZE_CLASSES[size],
    active ? 'border-primary bg-primary/10' : 'border-border bg-card/60 hover:bg-secondary/60',
  );
}
