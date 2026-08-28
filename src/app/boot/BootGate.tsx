import { useState, type ReactNode } from 'react';
import { assertExhaustive } from '@/lib/exhaustive';
import { useDatabaseBoot } from './useDatabaseBoot';
import { BootResultProvider } from './boot-context';
import { acknowledgeDbLoss } from '@/db/db-presence';
import {
  StartingScreen,
  UnsupportedScreen,
  MultiTabScreen,
  BootErrorScreen,
  DataLossScreen,
} from './BootScreens';

/**
 * Gates the application behind a successful database boot (spec §2.2, §2.2.7, §3).
 * Renders the appropriate pre-app screen for each non-ready state, and only mounts
 * the route tree — with the boot result in context — once the database is ready.
 */
export function BootGate({ children }: { children: ReactNode }) {
  const state = useDatabaseBoot();
  /**
   * Whether the user has read the "your data is gone" notice and chosen to carry on (issue #505).
   * Held here rather than folded back into the boot state machine: the database *is* ready in
   * that state, so this is only about whether the notice still stands in front of it.
   */
  const [lossAcknowledged, setLossAcknowledged] = useState(false);

  switch (state.status) {
    case 'starting':
      return <StartingScreen />;
    case 'unsupported':
      return <UnsupportedScreen diagnosis={state.diagnosis} />;
    case 'multi-tab':
      return <MultiTabScreen reason={state.reason} whenReleased={state.whenReleased} />;
    case 'error':
      return <BootErrorScreen error={state.error} />;
    case 'data-lost':
      return lossAcknowledged ? (
        <BootResultProvider value={state.result}>{children}</BootResultProvider>
      ) : (
        <DataLossScreen
          loss={state.loss}
          onContinue={() => {
            // Persist the acknowledgement first — the point of recording it is that the notice
            // survives a tab closed on it, so it must not depend on this render happening.
            acknowledgeDbLoss();
            setLossAcknowledged(true);
          }}
        />
      );
    case 'ready':
      return <BootResultProvider value={state.result}>{children}</BootResultProvider>;
    default:
      // A component has no declared return type to make the switch exhaustive on its own
      // (issue #355), so the guard is explicit: adding a `BootState` status without a case
      // here stops compiling instead of rendering a blank page with neither the route tree
      // nor an error screen. The fallback is the starting screen rather than `null` — an
      // unrecognised state means the boot has not finished as far as this gate can tell, and
      // saying so is honest where a blank page says nothing at all.
      assertExhaustive(state);
      return <StartingScreen />;
  }
}
