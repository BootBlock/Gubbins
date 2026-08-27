/**
 * The module switch, and the off → on → off round-trip (issue #79, plan §3).
 *
 * Plan §3 names this "the behaviour to test hardest — a one-way door here would be a data-loss
 * bug". The two directions are asserted separately because they fail differently: switching *on*
 * for an install that never asked is the upgrade hazard, and switching *off* leaving the app
 * still enforcing (or worse, still refusing) is the lock-in hazard.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useModulesStore } from '@/state/stores/useModulesStore';
import { useSessionStore } from '@/state/stores/useSessionStore';
import { UNRESTRICTED_AUTHORITY } from './permissions';
import { usersModuleEnabled } from './module';

const getUserRepository = vi.fn();
const getRoleRepository = vi.fn();
vi.mock('@/db/repositories', () => ({
  getUserRepository: () => getUserRepository(),
  getRoleRepository: () => getRoleRepository(),
}));

import { refreshAuthority } from './authority-refresh';
import { ADMIN_USER_ID } from '@/db/repositories/constants';

const RESTRICTED_USER = {
  id: 'user-1',
  kind: 'normal' as const,
  isEnabled: true,
  roleId: 'role-1',
  displayName: 'Sam Okafor',
};

beforeEach(() => {
  useModulesStore.setState({ intent: {}, firstRunComplete: false });
  useSessionStore.setState({ session: null, authority: UNRESTRICTED_AUTHORITY, actorId: ADMIN_USER_ID });
  getUserRepository.mockReturnValue({ getById: vi.fn().mockResolvedValue(RESTRICTED_USER) });
  getRoleRepository.mockReturnValue({
    getById: vi.fn().mockResolvedValue({ id: 'role-1', permissions: ['items:read'] }),
  });
});

describe('usersModuleEnabled', () => {
  it('is off for an install that has never chosen it', () => {
    // The state every existing install upgrades into. If this ever flips to true by default, a
    // release would put a sign-in in front of people who never asked for one.
    expect(usersModuleEnabled()).toBe(false);
  });

  it('follows the modules store in both directions', () => {
    useModulesStore.getState().setFeatureIntent('users', true);
    expect(usersModuleEnabled()).toBe(true);
    useModulesStore.getState().setFeatureIntent('users', false);
    expect(usersModuleEnabled()).toBe(false);
  });

  it('stays off when a preset is applied', () => {
    // Presets sweep every optional feature; picking one is a statement about which screens you
    // want, and must never be the thing that turns sign-in on.
    useModulesStore.getState().applyPreset('everything');
    expect(usersModuleEnabled()).toBe(false);
  });

  it('stays off after a reset to defaults', () => {
    useModulesStore.getState().setFeatureIntent('users', true);
    useModulesStore.getState().resetToEverything();
    expect(usersModuleEnabled()).toBe(false);
  });
});

describe('turning the module off again (plan §3)', () => {
  it('returns the session to unrestricted immediately, so nobody is left refused', () => {
    // On: the signed-in user's real authority applies. `modules:write` because switching the
    // module back off is gated on it (issues #429, #630), and this case is about the off
    // direction *working*, not about who may take it.
    getRoleRepository.mockReturnValue({
      getById: vi.fn().mockResolvedValue({ id: 'role-1', permissions: ['modules:write'] }),
    });
    useModulesStore.getState().setFeatureIntent('users', true);
    useSessionStore.setState({
      session: { userId: RESTRICTED_USER.id, displayName: RESTRICTED_USER.displayName, signedInAt: 1 },
    });

    return refreshAuthority()
      .then((resolved) => {
        expect(resolved.authority).toEqual({ mode: 'granted', grants: new Set(['modules:write']) });
        expect(resolved.actorId).toBe(RESTRICTED_USER.id);

        // Off again: the app must stop enforcing immediately. A stale restricted authority here is
        // the one-way door — the user has switched the feature off and is still being refused.
        useModulesStore.getState().setFeatureIntent('users', false);
        expect(usersModuleEnabled()).toBe(false);
        return refreshAuthority();
      })
      .then((resolved) => {
        expect(resolved.authority).toEqual(UNRESTRICTED_AUTHORITY);
        // Attribution stays with the person who is still signed in, rather than reverting to Admin
        // and putting the built-in account's name on their later changes (issue #630).
        expect(resolved.actorId).toBe(RESTRICTED_USER.id);
      });
  });

  it('refuses an account without `modules:write`, by every route into the store', async () => {
    // The three screens that can ask for this are gated (issue #429); this is the same rule at
    // the write itself, so a door added later is refused rather than quietly ungated (#630).
    useModulesStore.getState().setFeatureIntent('users', true);
    useSessionStore.setState({
      session: { userId: RESTRICTED_USER.id, displayName: RESTRICTED_USER.displayName, signedInAt: 1 },
    });
    await refreshAuthority();

    useModulesStore.getState().setFeatureIntent('users', false);
    expect(usersModuleEnabled()).toBe(true);
    useModulesStore.getState().applyPreset('minimal');
    expect(usersModuleEnabled()).toBe(true);
    useModulesStore.getState().resetToEverything();
    expect(usersModuleEnabled()).toBe(true);

    // Everything else the preset asked for still applied — the guard pins one module, it does not
    // reject the whole choice.
    expect(useModulesStore.getState().intent.users).toBe(true);
  });

  it('lets a signed-out device switch it off, so the lockout hatch still works', async () => {
    // The sign-in screen's "Can't sign in?" button writes this same intent, from a device whose
    // authority denies everything. It is the documented way back in after a forgotten password.
    useModulesStore.getState().setFeatureIntent('users', true);
    await refreshAuthority();
    expect(useSessionStore.getState().authority).toEqual({ mode: 'denied', reason: 'signed-out' });

    useModulesStore.getState().setFeatureIntent('users', false);
    expect(usersModuleEnabled()).toBe(false);
  });

  it('keeps the session, so switching back on does not require signing in again', async () => {
    getRoleRepository.mockReturnValue({
      getById: vi.fn().mockResolvedValue({ id: 'role-1', permissions: ['modules:write'] }),
    });
    useModulesStore.getState().setFeatureIntent('users', true);
    useSessionStore.setState({
      session: { userId: RESTRICTED_USER.id, displayName: RESTRICTED_USER.displayName, signedInAt: 1 },
    });
    await refreshAuthority();

    useModulesStore.getState().setFeatureIntent('users', false);
    await refreshAuthority();
    // Turning the module off must not sign anyone out or discard who they are — that would make
    // the toggle destructive in a way the plan forbids.
    expect(useSessionStore.getState().session?.userId).toBe(RESTRICTED_USER.id);

    useModulesStore.getState().setFeatureIntent('users', true);
    const resolved = await refreshAuthority();
    expect(resolved.authority).toEqual({ mode: 'granted', grants: new Set(['modules:write']) });
    expect(resolved.actorId).toBe(RESTRICTED_USER.id);
  });

  it('does not read the database at all while the module is off and nobody is signed in', async () => {
    // Single-user mode is the overwhelmingly common case and must stay free — and, more to the
    // point, must not be able to fail on a database error and deny. A device still holding a
    // session reads one row to attribute its writes; that case is covered in
    // `authority-refresh.test.ts`, and it too can never deny.
    const getById = vi.fn();
    getUserRepository.mockReturnValue({ getById });

    const resolved = await refreshAuthority();
    expect(getById).not.toHaveBeenCalled();
    expect(resolved.authority).toEqual(UNRESTRICTED_AUTHORITY);
  });
});
