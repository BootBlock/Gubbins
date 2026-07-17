import { type InputHTMLAttributes, type TextareaHTMLAttributes, forwardRef } from 'react';
import { cn } from '@/lib/utils';
import { NumberInput } from './number-input';

/**
 * Foundry form controls (spec §2.4.1). Hand-built minimal primitives feature code
 * imports instead of reaching for shadcn/raw elements directly; swappable later.
 */
const fieldClasses =
  'h-10 w-full rounded-lg border border-border bg-input/40 px-3 text-sm text-foreground shadow-sm outline-none transition-colors placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/40 disabled:cursor-not-allowed disabled:opacity-50';

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

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(
  ({ className, rows = 3, ...props }, ref) => (
    // Shares the field look but is auto-height (min-h, not the fixed h-10 of one-liners)
    // and vertically resizable.
    <textarea
      ref={ref}
      rows={rows}
      className={cn(fieldClasses, 'h-auto min-h-[4.5rem] resize-y py-2 leading-relaxed', className)}
      {...props}
    />
  ),
);
Textarea.displayName = 'Textarea';

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
        'size-4 shrink-0 cursor-pointer rounded border-border accent-primary outline-none',
        'focus-visible:ring-[3px] focus-visible:ring-ring/40',
        'disabled:cursor-not-allowed disabled:opacity-50',
        className,
      )}
      {...props}
    />
  ),
);
Checkbox.displayName = 'Checkbox';
