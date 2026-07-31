import { type InputHTMLAttributes, forwardRef } from 'react';
import { cn } from '@/lib/utils';
import { fieldClasses } from './field-classes';
import { NumberInput } from './number-input';

/**
 * Foundry form controls (spec §2.4.1). Hand-built minimal primitives feature code
 * imports instead of reaching for shadcn/raw elements directly; swappable later.
 *
 * The multi-line control lives next door in `textarea.tsx` — it grew behaviour of its own
 * (a remembered user-chosen size, optional auto-grow) that these one-liners don't share.
 */

export interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  /**
   * Whether a `type="number"` field gets the built-in micro-calculator (issue #93). On by
   * default; pass `calc={false}` for the rare numeric field where typing a sum makes no
   * sense (e.g. a fixed-format code). Ignored for non-number inputs.
   */
  readonly calc?: boolean;
}

export const Input = forwardRef<HTMLInputElement, InputProps>(
  ({ className, type = 'text', calc, ...props }, ref) => {
    // Every `type="number"` box is really a calculator-enabled control (see {@link NumberInput}):
    // it needs a text field to hold operator characters, so the delegation happens here rather
    // than at each of the app's ~50 numeric call sites.
    if (type === 'number' && calc !== false) {
      return <NumberInput ref={ref} className={className} {...props} />;
    }
    return <input ref={ref} type={type} className={cn(fieldClasses, className)} {...props} />;
  },
);
Input.displayName = 'Input';

/**
 * A styled checkbox — the Foundry replacement for raw `<input type="checkbox">` at call
 * sites (spec §2.4.1, and the "no hand-rolled controls" rule). Uses the `primary` accent
 * token for the tick and the shared `ring` token for the keyboard focus outline, so it
 * themes and dark-modes for free. A bare input (like {@link Input}) — pair it with your own
 * `<label>` at the call site; forwards its ref and spreads props so it drops straight into
 * React Hook Form's `register()`.
 */
export const Checkbox = forwardRef<HTMLInputElement, Omit<InputHTMLAttributes<HTMLInputElement>, 'type'>>(
  ({ className, ...props }, ref) => (
    <input
      ref={ref}
      type="checkbox"
      className={cn(
        'size-4 shrink-0 cursor-pointer rounded border-border accent-primary',
        // An `outline` rather than the soft `ring` halo above — see the note in `radio.tsx`: a
        // native tick box paints no border to carry the halo, so at 40% alpha it would be the only
        // indicator and fall under the 3:1 WCAG 1.4.11 wants, and a `box-shadow` ring disappears
        // altogether under `forced-colors`.
        'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring',
        'disabled:cursor-not-allowed disabled:opacity-50',
        className,
      )}
      {...props}
    />
  ),
);
Checkbox.displayName = 'Checkbox';
