import { type ReactElement, type ReactNode, cloneElement, isValidElement, useId } from 'react';
import { cn } from '@/lib/utils';
import { fieldAria } from './field-aria';
import { InfoHint } from './info-hint';

export interface FormFieldProps {
  readonly label: ReactNode;
  /** Validation message; when present the control is marked invalid and this is announced. */
  readonly error?: string;
  readonly className?: string;
  /**
   * Optional rich-Markdown help, surfaced via an {@link InfoHint} `i` badge at the
   * field's top-right. It lives *outside* the `<label>` so it never folds into the
   * control's accessible name.
   */
  readonly hint?: string;
  /** The single form control (Input/Select/…) the label and error describe. */
  readonly children: ReactNode;
}

/**
 * Foundry FormField — a labelled control that wires its validation error to the
 * control for assistive tech (spec §3 "modern accessible UI components" / WCAG
 * 3.3.1 Error Identification, 1.3.1 Info & Relationships, 4.1.3 Status Messages).
 *
 * It wraps the control in a `<label>` (implicit label association — the control
 * needs no `id`), injects `aria-invalid` + `aria-describedby` onto the control
 * *only when invalid*, and renders the message in a `role="alert"` element that is
 * announced on insertion (the canonical, W3C-recommended pattern for validation
 * errors, which — unlike a `role="status"` region, see {@link LiveRegion} — does
 * announce reliably when inserted at error time). The conditional-attribute logic
 * is the pure {@link fieldAria} seam.
 *
 * The single control child is cloned to receive the ARIA props, so call sites read
 * as plainly as the bare markup did: `<FormField label="Name" error={…}><Input
 * {...register('name')} /></FormField>`. The child's own props always win, so an
 * explicit `aria-*` at the call site is never clobbered.
 */
export function FormField({ label, error, className, hint, children }: FormFieldProps) {
  const fieldId = useId();
  const { controlProps, errorId, hasError } = fieldAria(fieldId, error);
  const control = isValidElement(children)
    ? cloneElement(children as ReactElement<Record<string, unknown>>, {
        ...controlProps,
        ...(children.props as Record<string, unknown>),
      })
    : children;
  // The error lives *outside* the <label> (referenced only by `aria-describedby`):
  // nesting it inside would fold the message into the control's accessible name. The
  // hint badge is likewise a sibling of the <label>, for the same reason.
  return (
    <div className={cn('relative', className)}>
      <label className="block">
        <span className={cn('mb-field-gap block text-sm font-medium', hint && 'pr-6')}>{label}</span>
        {control}
      </label>
      {hint ? (
        <span className="absolute right-0 top-0.5">
          <InfoHint content={hint} />
        </span>
      ) : null}
      {hasError ? (
        <span id={errorId} role="alert" className="mt-1 block text-xs text-destructive">
          {error}
        </span>
      ) : null}
    </div>
  );
}
