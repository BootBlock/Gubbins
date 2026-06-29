import { type HTMLAttributes, type ReactNode, forwardRef } from 'react';
import { cn } from '@/lib/utils';
import { type LiveUrgency, liveRegionAttrs } from './aria-live';

export type { LiveUrgency } from './aria-live';

/**
 * Foundry LiveRegion — an accessible status announcer for in-place updates that
 * would otherwise change silently (spec §3 "modern accessible UI components" /
 * WCAG 4.1.3 Status Messages). It complements the Toast (which announces *mutation*
 * outcomes) by covering surfaces that update text in place after an explicit action
 * — e.g. the Sync screen's sync-result line or the scanner's manual-entry feedback.
 *
 * The container is **always mounted** and only its children change. This is the
 * crucial correctness detail: a `role="status"`/`aria-live` element that is itself
 * inserted into the DOM at the moment the message appears is frequently *not*
 * announced (several screen readers only watch regions that already existed), so
 * the live region must pre-exist and its content mutate. Callers therefore render
 * `<LiveRegion>{message ? <p>…</p> : null}</LiveRegion>` rather than rendering the
 * region conditionally.
 *
 * Politeness is resolved by the pure {@link liveRegionAttrs}. `visuallyHidden`
 * makes the region announce-only (`sr-only`) for cases where the visible feedback
 * already lives elsewhere (e.g. an interactive result card).
 */
export interface LiveRegionProps extends HTMLAttributes<HTMLDivElement> {
  /** `polite` (default) queues behind speech; `assertive` interrupts (errors). */
  readonly urgency?: LiveUrgency;
  /** Announce only, render nothing visible (`sr-only`). */
  readonly visuallyHidden?: boolean;
  readonly children?: ReactNode;
}

export const LiveRegion = forwardRef<HTMLDivElement, LiveRegionProps>(
  ({ urgency = 'polite', visuallyHidden = false, className, children, ...props }, ref) => (
    <div
      ref={ref}
      {...liveRegionAttrs(urgency)}
      className={cn(visuallyHidden && 'sr-only', className)}
      {...props}
    >
      {children}
    </div>
  ),
);
LiveRegion.displayName = 'LiveRegion';
