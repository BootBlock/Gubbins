/**
 * Pure ARIA live-region attribute mapping (spec §3 "modern accessible UI
 * components" / WCAG 4.1.3 Status Messages).
 *
 * Separated from the {@link LiveRegion} component (the "extract the small
 * decision out of the DOM glue" seam, à la `resolveTheme` / `describeScrapeError`)
 * so the role ↔ politeness pairing is exhaustively unit-testable without a DOM.
 */

/** How urgently a status update should interrupt the user. */
export type LiveUrgency = 'polite' | 'assertive';

/** The ARIA attributes a live region carries for a given urgency. */
export interface LiveRegionAttrs {
  readonly role: 'status' | 'alert';
  readonly 'aria-live': LiveUrgency;
  readonly 'aria-atomic': boolean;
}

/**
 * Map an urgency to the matching ARIA attributes.
 *
 * `polite` → `role="status"` + `aria-live="polite"` (queued behind speech in
 * progress — the right default for an outcome that can wait, e.g. a sync result).
 * `assertive` → `role="alert"` + `aria-live="assertive"` (interrupts — for errors
 * the user must hear now). Both are `aria-atomic` so the whole region is
 * re-announced on any change rather than just the diffed text node, which keeps a
 * multi-part status ("CLEAN · pulled 3 · deleted 1") coherent.
 *
 * Pairing `role` *and* `aria-live` is deliberate redundancy: `role` carries an
 * implicit live politeness, but several screen readers only honour an explicit
 * `aria-live`, so we set both.
 */
export function liveRegionAttrs(urgency: LiveUrgency): LiveRegionAttrs {
  return urgency === 'assertive'
    ? { role: 'alert', 'aria-live': 'assertive', 'aria-atomic': true }
    : { role: 'status', 'aria-live': 'polite', 'aria-atomic': true };
}
