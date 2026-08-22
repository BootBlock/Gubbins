/**
 * Signing out of this device (issue #79, plan §3).
 *
 * Its own module rather than a second export from `SignInGate.tsx`: a file that exports both a
 * component and a hook loses fast refresh for the component, and the lint rule says so.
 */
import { useCallback } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useSessionStore } from '@/state/stores/useSessionStore';
import { refreshAuthority } from './authority-refresh';
import { forgetDeviceCredentials } from './device-credentials';

/**
 * Sign out of this device.
 *
 * Clears the session, returns the derived authority to its default, drops every cached query, and
 * forgets this device's portable credentials — leaving one user's data (or their bridge token)
 * resident for the next person to sign in is the obvious way this feature would leak.
 */
export function useSignOut(): () => Promise<void> {
  const signOut = useSessionStore((state) => state.signOut);
  const queryClient = useQueryClient();

  return useCallback(async () => {
    forgetDeviceCredentials();
    signOut();
    await refreshAuthority();
    queryClient.clear();
  }, [queryClient, signOut]);
}
