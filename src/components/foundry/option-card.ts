/**
 * Shared chrome for a selectable option card — a tile the user picks from a set.
 *
 * Several features render such a card: the Modules manager grid and the first-run chooser
 * present the curated presets, and the users screens present their own choices. Each uses
 * different selection semantics (a multi-toggle `aria-pressed` button vs a `role="radio"`)
 * and different inner layouts. What they must NOT let drift apart is the card's visual
 * language — its base border/padding and, crucially, the selected/unselected token pair — so
 * a single retint stays consistent across every surface. Because more than one feature
 * composes it, that shared chrome belongs in the Foundry rather than in any one feature; each
 * call site adds its own layout and wires its own interaction/ARIA on top.
 */
import { cn } from '@/lib/utils';

/**
 * The base + selection-state classes for an option card. Callers `cn()` their own layout
 * (flex direction, gaps, icon sizing) on top. `active` picks the selected token pair.
 */
export function optionCardClassName(active: boolean): string {
  return cn(
    'rounded-xl border p-4 text-left transition-colors duration-150 ease-emphasized outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:border-ring',
    active ? 'border-primary bg-primary/10' : 'border-border bg-card/60 hover:bg-secondary/60',
  );
}
