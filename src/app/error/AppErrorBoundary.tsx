import type { ReactNode } from 'react';
import { ErrorBoundary } from 'react-error-boundary';
import { SafeMode } from './SafeMode';

/**
 * Top-level React error boundary (spec §3). Catches render/runtime crashes and
 * swaps in the Safe Mode rescue UI instead of a blank white screen.
 */
export function AppErrorBoundary({ children }: { children: ReactNode }) {
  return (
    <ErrorBoundary
      FallbackComponent={SafeMode}
      onError={(error, info) => console.error('[gubbins] application crashed', error, info)}
    >
      {children}
    </ErrorBoundary>
  );
}
