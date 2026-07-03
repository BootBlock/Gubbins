/**
 * Shared chrome for a selectable preset card (modular-ui-plan §2.5).
 *
 * Both the Modules manager grid and the first-run chooser render the curated {@link PRESETS}
 * as selectable cards, but with different selection semantics (a multi-toggle `aria-pressed`
 * button in the manager vs a `role="radio"` in the chooser) and different inner layouts.
 * What they must NOT let drift apart is the card's visual language — its base border/padding
 * and, crucially, the selected/unselected token pair — so a single retint stays consistent
 * across both surfaces. That shared chrome lives here; each call site adds its own layout and
 * wires its own interaction/ARIA on top.
 */
import { cn } from '@/lib/utils';

/**
 * The base + selection-state classes for a preset card. Callers `cn()` their own layout
 * (flex direction, gaps, icon sizing) on top. `active` picks the selected token pair.
 */
export function presetCardClassName(active: boolean): string {
  return cn(
    'rounded-xl border p-4 text-left transition-colors duration-150 ease-emphasized outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:border-ring',
    active ? 'border-primary bg-primary/10' : 'border-border bg-card/60 hover:bg-secondary/60',
  );
}
