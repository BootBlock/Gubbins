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
import { useFeature } from '@/features/modules/useFeature';
import { refreshAuthority } from './authority-refresh';
import { forgetDeviceCredentials } from './device-credentials';
import { userKeys } from './queries';
import { SignInScreen } from './SignInScreen';

export function SignInGate({ children }: { children: ReactNode }) {
  // Subscribed rather than read once: the module is toggled from the Modules manager *inside*
  // the app, so switching it on must put the gate up — and switching it off must take it down —
  // without a reload. `usersModuleEnabled()` is the same question asked outside a render.
  const moduleEnabled = useFeature('users');
  const session = useSessionStore((state) => state.session);
  const signIn = useSessionStore((state) => state.signIn);
  const signOut = useSessionStore((state) => state.signOut);
  const authority = useSessionStore((state) => state.authority);
  const queryClient = useQueryClient();
  // Everything the resolved authority depends on, as one value. The gate is **derived** from it
  // rather than pushed closed by an effect: `resolved` goes false on the very render where an
  // input changes, so there is no frame in which the app is mounted under the previous
  // principal's authority. Pushing it closed instead would leave that frame visible for exactly
  // as long as it took the effect to run.
  const resolutionKey = `${moduleEnabled}:${session?.userId ?? ''}`;
  const [resolvedKey, setResolvedKey] = useState<string | null>(null);
  const resolved = resolvedKey === resolutionKey;

  useEffect(() => {
    let cancelled = false;
    // Runs for the module-**off** transition too, not just on. Turning the module off must
    // return the app to acting as Admin immediately; skipping the refresh here would leave the
    // previous restricted (or denied) authority resident, so a user who had just switched the
    // feature off would still be refused — a one-way door in the direction the plan (§3) says
    // must stay safe.
    //
    // Always release the render. A refresh can fail for reasons unrelated to the session — a
    // database briefly unavailable, a failed read — and leaving this shut would hold the app on
    // a blank screen indefinitely, with no error and no way out. `refreshAuthority` never
    // rejects and publishes a *denied* authority if it cannot establish one, so releasing here
    // shows an app that refuses actions rather than one that silently permits them.
    void refreshAuthority().then(() => {
      if (!cancelled) setResolvedKey(resolutionKey);
    });
    return () => {
      cancelled = true;
    };
  }, [resolutionKey]);

  /**
   * The session names an account that can no longer be used — deleted (locally or arriving by
   * sync), or disabled, including by the signed-in person editing their own row.
   *
   * Only these two reasons end the session. `no-role` and `no-permissions` are legitimate
   * signed-in states an administrator is expected to fix by granting a role; bouncing those to
   * the sign-in screen would just loop, because signing in again lands in the same place.
   */
  const sessionRevoked =
    moduleEnabled &&
    session !== null &&
    resolved &&
    authority.mode === 'denied' &&
    (authority.reason === 'signed-out' || authority.reason === 'disabled');

  useEffect(() => {
    // Drop the dead session so the gate offers the account list again. Without this the app
    // stays mounted refusing every action, with nothing on screen explaining why. The device's
    // credentials go with it for the same reason a deliberate sign-out drops them (issue #521):
    // this path fires when the account was disabled or deleted, which is precisely when its
    // bridge token must stop being usable from this device.
    if (sessionRevoked) {
      forgetDeviceCredentials();
      signOut();
    }
  }, [sessionRevoked, signOut]);

  const candidates = useQuery({
    queryKey: userKeys.signInCandidates(),
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
        // The gate needs no explicit closing here: publishing the session changes the resolution
        // key, so the first render that sees the new session already reads `resolved` as false
        // and stays shut until the real authority has been resolved for that user.
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

  // Render nothing for the beat between spotting a revoked session and the effect clearing it,
  // rather than the app under an authority that permits nothing.
  if (sessionRevoked) return null;

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
