import type { ReactNode } from 'react';
import { ErrorBoundary } from 'react-error-boundary';

/**
 * A **local** error boundary for one independent piece of UI — a dashboard widget, an item
 * card — so a render crash in it degrades to a small inline message instead of taking its
 * whole screen down.
 *
 * The app has two coarser tiers above this: the router's per-route error screen and, above
 * that, {@link AppErrorBoundary} → Safe Mode. Both are correct for a screen that genuinely
 * can't render, but they're far too blunt for a repeated, self-contained tile: one malformed
 * row shouldn't blank the dashboard or the inventory list (issue #313).
 *
 * `resetKeys` is how a contained failure recovers: pass the data the subtree renders (e.g. the
 * item object), and the boundary retries the render as soon as that data changes — so a row
 * that failed on stale data comes back by itself once the query refetches, with no reload.
 */
export function ContainedErrorBoundary({
  what,
  fallback,
  resetKeys,
  children,
}: {
  /** What crashed, for the console log — e.g. `'dashboard widget "lowStock"'`. Not user-facing. */
  what: string;
  /** The inline stand-in rendered in place of the crashed subtree. Keep it the same shape. */
  fallback: ReactNode;
  /** Values that, when changed, retry the failed render. */
  resetKeys?: unknown[];
  children: ReactNode;
}) {
  return (
    <ErrorBoundary
      fallback={fallback}
      resetKeys={resetKeys}
      onError={(error, info) => console.error(`[gubbins] ${what} failed to render`, error, info)}
    >
      {children}
    </ErrorBoundary>
  );
}
