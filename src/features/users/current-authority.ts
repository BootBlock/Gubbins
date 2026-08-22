/**
 * The live session's authority, for the app's own production wiring (issue #519).
 *
 * Kept apart from `assert-permission.ts` on purpose: that module is imported by
 * `db/repositories/base.ts`, which the Bridge loads through Node's strip-only loader, and a
 * Zustand store has no business in that graph. Everything here is browser-only.
 *
 * The engines that need a permission check take the authority as an injected port so they stay
 * drivable in unit tests without a store; this is the single place those ports are bound to the
 * real session. It is deliberately a function, not a captured value — signing in or out must
 * take effect immediately, exactly as `productionOptions.resolveAuthority` does for repositories.
 */
import { useSessionStore } from '@/state/stores/useSessionStore';
import type { Authority } from './permissions';

/** What the session running right now may do. */
export function currentAuthority(): Authority {
  return useSessionStore.getState().authority;
}
