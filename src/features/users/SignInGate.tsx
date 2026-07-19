/**
 * The gate that stands between an unauthenticated device and the app (issue #79, plan §3).
 *
 * A **gate**, not a route. A `/sign-in` route would be reachable by URL, leave the rest of the
 * app mounted behind it, and let the back button step past it — none of which is what "sign-in
 * is required" means. Wrapping the app means there is simply nothing else rendered until a
 * session exists.
 *
 * With the users module off it renders its children untouched and does no work at all, which
 * is the state Gubbins ships in and every existing install stays in.
 */
import { useCallback, useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { getUserRepository } from '@/db/repositories';
import type { SignInOutcome } from '@/db/repositories/UserRepository';
import { useSessionStore } from '@/state/stores/useSessionStore';
import { refreshAuthority } from './authority-refresh';
import { usersModuleEnabled } from './module';
import { SignInScreen } from './SignInScreen';

export function SignInGate({ children }: { children: ReactNode }) {
  const moduleEnabled = usersModuleEnabled();
  const session = useSessionStore((state) => state.session);
  const signIn = useSessionStore((state) => state.signIn);
  const queryClient = useQueryClient();
  // Until the first refresh resolves we do not yet know what the restored session may do, and
  // rendering the app against a stale authority is exactly the gap this guards.
  const [resolved, setResolved] = useState(!moduleEnabled);

  useEffect(() => {
    if (!moduleEnabled) return;
    setResolved(false);
    let cancelled = false;
    // Always release the render. A refresh can fail for reasons unrelated to the session — a
    // database briefly unavailable, a failed read — and leaving this false would hold the app
    // on a blank screen indefinitely, with no error and no way out. `refreshAuthority` never
    // rejects and publishes a *denied* authority if it cannot establish one, so releasing here
    // shows an app that refuses actions rather than one that silently permits them.
    void refreshAuthority().then(() => {
      if (!cancelled) setResolved(true);
    });
    return () => {
      cancelled = true;
    };
  }, [moduleEnabled, session?.userId]);

  const candidates = useQuery({
    queryKey: ['users', 'sign-in-candidates'],
    queryFn: () => getUserRepository().listSignInCandidates(),
    enabled: moduleEnabled && !session,
  });

  const handleSignIn = useCallback(
    async (userId: string, password: string): Promise<SignInOutcome> => {
      const outcome = await getUserRepository().verifySignIn(userId, password);
      if (outcome.ok) {
        // Drop the stale cache *before* the session is published. Everything already fetched
        // was read as the previous principal (or as nobody), and a restricted user must not be
        // shown a list the cache filled while unrestricted.
        await queryClient.invalidateQueries();
        // Close the render gate in the same update as the session. Publishing the session
        // alone would let React render with `session` set while `resolved` was still true from
        // the signed-out refresh, mounting the whole app for a beat under the *previous*
        // principal's authority. Both state updates batch, so the first render that sees the
        // new session also sees the gate shut, and the effect above reopens it once the real
        // authority has been resolved.
        setResolved(false);
        signIn({
          userId: outcome.user.id,
          displayName: outcome.user.displayName,
          signedInAt: Date.now(),
        });
      }
      return outcome;
    },
    [queryClient, signIn],
  );

  if (!moduleEnabled) return <>{children}</>;

  if (!session) {
    return (
      <SignInScreen users={candidates.data ?? []} loading={candidates.isPending} onSignIn={handleSignIn} />
    );
  }

  // A restored session whose authority has not been resolved yet renders nothing rather than
  // the app: the repository guards would otherwise answer from the store's unrestricted
  // default for the moment it takes to read the user and their role back.
  if (!resolved) return null;

  return <>{children}</>;
}

/**
 * Sign out of this device.
 *
 * Clears the session, returns the derived authority to its default, and drops every cached
 * query — leaving one user's data resident for the next person to sign in is the obvious way
 * this feature would leak.
 */
export function useSignOut(): () => Promise<void> {
  const signOut = useSessionStore((state) => state.signOut);
  const queryClient = useQueryClient();

  return useCallback(async () => {
    signOut();
    await refreshAuthority();
    queryClient.clear();
  }, [queryClient, signOut]);
}
