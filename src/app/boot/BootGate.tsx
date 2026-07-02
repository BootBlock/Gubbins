import type { ReactNode } from 'react';
import { useDatabaseBoot } from './useDatabaseBoot';
import { BootResultProvider } from './boot-context';
import { StartingScreen, UnsupportedScreen, MultiTabScreen, BootErrorScreen } from './BootScreens';

/**
 * Gates the application behind a successful database boot (spec §2.2, §2.2.7, §3).
 * Renders the appropriate pre-app screen for each non-ready state, and only mounts
 * the route tree — with the boot result in context — once the database is ready.
 */
export function BootGate({ children }: { children: ReactNode }) {
  const state = useDatabaseBoot();

  switch (state.status) {
    case 'starting':
      return <StartingScreen />;
    case 'unsupported':
      return <UnsupportedScreen missing={state.missing} />;
    case 'multi-tab':
      return <MultiTabScreen whenReleased={state.whenReleased} />;
    case 'error':
      return <BootErrorScreen error={state.error} />;
    case 'ready':
      return <BootResultProvider value={state.result}>{children}</BootResultProvider>;
  }
}
