import {
  type InputHTMLAttributes,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
  forwardRef,
} from 'react';
import { cn } from '@/lib/utils';

/**
 * Foundry form controls (spec §2.4.1). Hand-built minimal primitives feature code
 * imports instead of reaching for shadcn/raw elements directly; swappable later.
 */
const fieldClasses =
  'h-10 w-full rounded-lg border border-border bg-input/40 px-3 text-sm text-foreground shadow-sm outline-none transition-colors placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/40 disabled:cursor-not-allowed disabled:opacity-50';

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(
  ({ className, type = 'text', ...props }, ref) => (
    <input ref={ref} type={type} className={cn(fieldClasses, className)} {...props} />
  ),
);
Input.displayName = 'Input';

export const Select = forwardRef<HTMLSelectElement, SelectHTMLAttributes<HTMLSelectElement>>(
  ({ className, ...props }, ref) => (
    <select ref={ref} className={cn(fieldClasses, 'cursor-pointer pr-8', className)} {...props} />
  ),
);
Select.displayName = 'Select';

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
