import { type ReactElement, type ReactNode, cloneElement, isValidElement, useId } from 'react';
import { WarningIcon } from '@/components/icons';
import { cn } from '@/lib/utils';
import { fieldAria } from './field-aria';
import { InfoHint } from './info-hint';
import { LiveRegion } from './live-region';
import { type TooltipSize } from './tooltip';

export interface FormFieldProps {
  readonly label: ReactNode;
  /** Validation message; when present the control is marked invalid and this is announced. */
  readonly error?: string;
  /**
   * Advisory message for an entry that is accepted but looks wrong (issue #344) — shown
   * below the control and described to it, but *never* marks it invalid or blocks a save.
   * Ignored while an `error` is present, which outranks it.
   */
  readonly warning?: string;
  readonly className?: string;
  /**
   * Optional rich-Markdown help, surfaced via an {@link InfoHint} `i` badge at the
   * field's top-right. It lives *outside* the `<label>` so it never folds into the
   * control's accessible name.
   */
  readonly hint?: string;
  /** Widen the hint bubble for richer help (tables, code, longer docs). Defaults to `sm`. */
  readonly hintSize?: TooltipSize;
  /**
   * Render the denser label a *nested* editor uses — a muted `text-xs` caption at the compact
   * field gap, rather than the `text-sm font-medium` of a top-level form. Only the label changes;
   * the control, error and warning wiring is identical, so a panel inside a dialog gets the same
   * accessibility for free instead of hand-rolling a labelled `<div>` to keep its type scale.
   */
  readonly compact?: boolean;
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
 * Alongside the blocking `error` it offers an advisory `warning` tier (issue #344) for
 * an entry that saves fine but looks wrong — a mistyped barcode, say. That message is
 * described to the control but never marks it invalid, and lands in an always-mounted
 * {@link LiveRegion} so it is actually announced when it appears.
 *
 * The single control child is cloned to receive the ARIA props, so call sites read
 * as plainly as the bare markup did: `<FormField label="Name" error={…}><Input
 * {...register('name')} /></FormField>`. The child's own props always win, so an
 * explicit `aria-*` at the call site is never clobbered.
 */
export function FormField({
  label,
  error,
  warning,
  className,
  hint,
  hintSize,
  compact,
  children,
}: FormFieldProps) {
  const fieldId = useId();
  const { controlProps, errorId, warningId, hasError, hasWarning } = fieldAria(fieldId, error, warning);
  // The advisory slot is opt-in: passing a string (empty included) mounts the live region,
  // omitting the prop leaves the field exactly as it was. The region must pre-exist for its
  // later content to announce at all — see {@link LiveRegion}'s note — so a field that can
  // warn keeps an empty one mounted rather than inserting it at warn time.
  const warnable = typeof warning === 'string';
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
        <span
          className={cn(
            'block',
            compact
              ? 'mb-field-gap-compact text-xs text-muted-foreground'
              : 'mb-field-gap text-sm font-medium',
            hint && (compact ? 'pr-5' : 'pr-6'),
          )}
        >
          {label}
        </span>
        {control}
      </label>
      {hint ? (
        <span className={cn('absolute right-0', compact ? 'top-0' : 'top-0.5')}>
          <InfoHint content={hint} size={hintSize} />
        </span>
      ) : null}
      {hasError ? (
        <span id={errorId} role="alert" className="mt-1 block text-xs text-destructive">
          {error}
        </span>
      ) : null}
      {warnable ? (
        <LiveRegion>
          {hasWarning ? (
            <span id={warningId} className="mt-1 flex items-start gap-1 text-xs text-warning">
              <WarningIcon className="mt-px size-3.5 shrink-0" aria-hidden />
              {warning}
            </span>
          ) : null}
        </LiveRegion>
      ) : null}
    </div>
  );
}
