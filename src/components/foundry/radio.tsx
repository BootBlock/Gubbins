import { type InputHTMLAttributes, forwardRef } from 'react';
import { cn } from '@/lib/utils';

/**
 * A styled radio — the Foundry replacement for raw `<input type="radio">` at call sites
 * (spec §2.4.1, and the "no hand-rolled controls" rule). The sibling of `Checkbox`: it takes the
 * same `primary` accent token for the dot and the same shared `ring` token for the keyboard focus
 * outline, so a radio and a tick box read as one system and dark-mode correctly for free.
 *
 * A bare input, like `Input` and `Checkbox` — pair it with your own `<label>` at the call site.
 * Give every radio in one group the **same `name`**: that is what makes the browser enforce mutual
 * exclusivity and treat the group as a single arrow-key-navigable tab stop, and it is the caller's
 * job because only the caller knows where the group's boundaries are. Forwards its ref and spreads
 * props, so it drops straight into React Hook Form's `register()`.
 *
 * For a segmented button bar rather than a column of dots, reach for `SegmentedRadioGroup` instead.
 * That is a different control built on `role="radio"` buttons with its own roving-tabindex
 * keyboard handling — not a variant of this one.
 */
export const Radio = forwardRef<HTMLInputElement, Omit<InputHTMLAttributes<HTMLInputElement>, 'type'>>(
  ({ className, ...props }, ref) => (
    <input
      ref={ref}
      type="radio"
      className={cn(
        // `rounded-full` states the intent even though a native radio is drawn round by the UA:
        // it keeps the class list honest if a future restyle sets `appearance-none`.
        'size-4 shrink-0 cursor-pointer rounded-full border-border accent-primary',
        // Focus is an `outline`, not the soft `ring` halo used by `Input`/`Select`. Those pair the
        // halo with a full-opacity `focus-visible:border-ring` on an `appearance-none` box; a
        // native radio paints no border, so a 40%-alpha halo would be the *only* indicator and
        // lands near 1.8:1 — under the 3:1 WCAG 1.4.11 asks of a focus indicator. An outline is
        // also the one form that survives `forced-colors` (Windows High Contrast), where a
        // `box-shadow` ring is stripped entirely.
        'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring',
        'disabled:cursor-not-allowed disabled:opacity-50',
        className,
      )}
      {...props}
    />
  ),
);
Radio.displayName = 'Radio';
