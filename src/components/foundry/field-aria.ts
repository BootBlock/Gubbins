/**
 * Pure form-field ARIA wiring (spec §3 "modern accessible UI components" / WCAG
 * 3.3.1 Error Identification, 1.3.1 Info & Relationships, 4.1.3 Status Messages).
 *
 * Separated from the {@link FormField} component (the "extract the small decision
 * out of the DOM glue" seam, à la `liveRegionAttrs` / `focus-trap`) so the
 * id-derivation and conditional-attribute logic is unit-testable without a DOM.
 */

/** ARIA attributes spread onto a labelled control when it has a validation error. */
export interface FieldControlAria {
  readonly 'aria-invalid'?: true;
  readonly 'aria-describedby'?: string;
}

/** The complete wiring for one labelled field, derived from its id and error. */
export interface FieldAria {
  /** Spread onto the input/select; empty (no attributes) when the field is valid. */
  readonly controlProps: FieldControlAria;
  /** Stable id for the error element, referenced by `aria-describedby`. */
  readonly errorId: string;
  /** Whether a non-empty error message is present. */
  readonly hasError: boolean;
}

/**
 * Derive the ARIA wiring for a labelled field from its base id and current error.
 *
 * When (and only when) a non-blank error is present, the control is marked
 * `aria-invalid="true"` and pointed at the error element via `aria-describedby`,
 * and the error element (rendered with `role="alert"`) is announced on insertion.
 * A valid field carries no `aria-invalid`/`aria-describedby` at all, so assistive
 * tech never reads a phantom error. A whitespace-only message is treated as no
 * error so a stray space can't silently flip a field "invalid".
 */
export function fieldAria(fieldId: string, error?: string): FieldAria {
  const errorId = `${fieldId}-error`;
  const hasError = typeof error === 'string' && error.trim().length > 0;
  return {
    controlProps: hasError ? { 'aria-invalid': true, 'aria-describedby': errorId } : {},
    errorId,
    hasError,
  };
}
