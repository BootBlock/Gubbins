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

/** The complete wiring for one labelled field, derived from its id, error and warning. */
export interface FieldAria {
  /** Spread onto the input/select; empty (no attributes) when the field is valid and quiet. */
  readonly controlProps: FieldControlAria;
  /** Stable id for the error element, referenced by `aria-describedby`. */
  readonly errorId: string;
  /** Stable id for the warning element, referenced by `aria-describedby`. */
  readonly warningId: string;
  /** Whether a non-empty error message is present. */
  readonly hasError: boolean;
  /** Whether a non-empty warning message is present *and* not superseded by an error. */
  readonly hasWarning: boolean;
}

/**
 * Derive the ARIA wiring for a labelled field from its base id, current error and
 * current advisory warning.
 *
 * When (and only when) a non-blank error is present, the control is marked
 * `aria-invalid="true"` and pointed at the error element via `aria-describedby`,
 * and the error element (rendered with `role="alert"`) is announced on insertion.
 * A valid field carries no `aria-invalid` at all, so assistive tech never reads a
 * phantom error. A whitespace-only message is treated as no error so a stray space
 * can't silently flip a field "invalid".
 *
 * A **warning** (issue #344) is the advisory tier: the entry is accepted and savable,
 * but something about it looks wrong. It is described to the control the same way, but
 * never marks it invalid — so it reads as guidance, not rejection. An error outranks a
 * warning: when both are supplied only the error is wired and shown, because a field
 * that is outright invalid has nothing to gain from a softer second opinion.
 */
export function fieldAria(fieldId: string, error?: string, warning?: string): FieldAria {
  const errorId = `${fieldId}-error`;
  const warningId = `${fieldId}-warning`;
  const hasError = typeof error === 'string' && error.trim().length > 0;
  const hasWarning = !hasError && typeof warning === 'string' && warning.trim().length > 0;
  return {
    controlProps: hasError
      ? { 'aria-invalid': true, 'aria-describedby': errorId }
      : hasWarning
        ? { 'aria-describedby': warningId }
        : {},
    errorId,
    warningId,
    hasError,
    hasWarning,
  };
}
