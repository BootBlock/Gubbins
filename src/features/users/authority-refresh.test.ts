/**
 * Authority-refresh tests (issue #79, plan §3).
 *
 * This is the seam that decides what the repository guards will answer, so the cases below are
 * chosen for how they fail. Every one of them is a way to accidentally hand somebody more
 * access than they have.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { ADMIN_USER_ID } from '@/db/repositories/constants';
import type { Role, User } from '@/db/repositories/types';

const getById = vi.fn<(id: string) => Promise<User | undefined>>();
const getRoleById = vi.fn<(id: string) => Promise<Role | undefined>>();
const moduleEnabled = vi.fn<() => boolean>();

vi.mock('@/db/repositories', () => ({
  getUserRepository: () => ({ getById }),
  getRoleRepository: () => ({ getById: getRoleById }),
}));
vi.mock('./module', () => ({ usersModuleEnabled: () => moduleEnabled() }));

const { adoptAuthorityChange, refreshAuthority } = await import('./authority-refresh');
const { useSessionStore } = await import('@/state/stores/useSessionStore');

const USER: User = {
  id: 'u1',
  username: 'sam',
  displayName: 'Sam',
  email: null,
  hasPassword: true,
  isEnabled: true,
  disabledMessage: null,
  kind: 'normal',
  roleId: 'r1',
  createdAt: 0,
  updatedAt: 0,
};

const ROLE: Role = {
  id: 'r1',
  name: 'Stocker',
  description: null,
  permissions: ['items:read', 'items:write'],
  isBuiltin: true,
  createdAt: 0,
  updatedAt: 0,
};

beforeEach(() => {
  vi.clearAllMocks();
  moduleEnabled.mockReturnValue(true);
  getById.mockResolvedValue(USER);
  getRoleById.mockResolvedValue(ROLE);
  useSessionStore.setState({ session: null });
});

afterEach(() => {
  useSessionStore.setState({ session: null });
});

function signedIn(userId = 'u1'): void {
  useSessionStore.setState({ session: { userId, displayName: 'Sam', signedInAt: 0 } });
}

describe('refreshAuthority', () => {
  it('is unrestricted, as Admin, while the module is off — and reads no database at all', async () => {
    moduleEnabled.mockReturnValue(false);

    const resolved = await refreshAuthority();
    expect(resolved.authority).toEqual({ mode: 'unrestricted' });
    expect(resolved.actorId).toBe(ADMIN_USER_ID);
    // The overwhelmingly common case — module off, nobody signed in — must stay free.
    expect(getById).not.toHaveBeenCalled();
  });

  it('keeps attributing to the signed-in user once the module goes off (issue #630)', async () => {
    // The device was signed in when the module was switched off, and the person at it has not
    // changed. Reverting the actor to Admin would put the built-in account's name on their
    // changes, in the ledger that claims to record who made them.
    moduleEnabled.mockReturnValue(false);
    signedIn();

    const resolved = await refreshAuthority();
    expect(resolved.authority).toEqual({ mode: 'unrestricted' });
    expect(resolved.actorId).toBe('u1');
  });

  it('falls back to Admin, still unrestricted, when the session names nobody real', async () => {
    // Deleted account, or a read that failed. Neither says anything about whether the module is
    // on, so single-user mode must not be denied over it — only the attribution falls back.
    moduleEnabled.mockReturnValue(false);
    signedIn();
    getById.mockResolvedValue(undefined);

    let resolved = await refreshAuthority();
    expect(resolved.authority).toEqual({ mode: 'unrestricted' });
    expect(resolved.actorId).toBe(ADMIN_USER_ID);

    getById.mockRejectedValue(new Error('database unavailable'));
    resolved = await refreshAuthority();
    expect(resolved.authority).toEqual({ mode: 'unrestricted' });
    expect(resolved.actorId).toBe(ADMIN_USER_ID);
  });

  it('denies a signed-out device once the module is on', async () => {
    const resolved = await refreshAuthority();
    expect(resolved.authority).toEqual({ mode: 'denied', reason: 'signed-out' });
  });

  it('resolves a signed-in user against their role, from the database', async () => {
    signedIn();
    const resolved = await refreshAuthority();

    expect(resolved.actorId).toBe('u1');
    expect(resolved.authority).toEqual({ mode: 'granted', grants: new Set(['items:read', 'items:write']) });
  });

  it('denies — rather than falling back to Admin — when the account has gone', async () => {
    // The account may have been deleted on another device and arrived by sync. A signed-in
    // state that silently becomes full access is precisely what this feature exists to stop.
    getById.mockResolvedValue(undefined);
    signedIn('deleted-user');

    const resolved = await refreshAuthority();
    expect(resolved.authority).toEqual({ mode: 'denied', reason: 'signed-out' });
    expect(resolved.actorId).toBe(ADMIN_USER_ID);
  });

  it('denies a disabled account even though it still resolves', async () => {
    getById.mockResolvedValue({ ...USER, isEnabled: false });
    signedIn();

    const resolved = await refreshAuthority();
    expect(resolved.authority).toEqual({ mode: 'denied', reason: 'disabled' });
    // Attribution still follows the person: their writes are theirs, not Admin's.
    expect(resolved.actorId).toBe('u1');
  });

  it('denies a user with no role', async () => {
    getById.mockResolvedValue({ ...USER, roleId: null });
    signedIn();

    const resolved = await refreshAuthority();
    expect(resolved.authority).toEqual({ mode: 'denied', reason: 'no-role' });
    expect(getRoleById).not.toHaveBeenCalled();
  });

  it('denies — never keeps the unrestricted default — when the lookup fails', async () => {
    // The store's default is *unrestricted*, so "give up and leave what's there" would hand a
    // fresh page load full access the moment a read failed. It must fail closed, and must not
    // reject, or the gate holding the render would never reopen.
    getById.mockRejectedValue(new Error('database unavailable'));
    signedIn();

    const resolved = await refreshAuthority();
    expect(resolved.authority).toEqual({ mode: 'denied', reason: 'signed-out' });
    expect(useSessionStore.getState().authority).toEqual({ mode: 'denied', reason: 'signed-out' });
  });

  it('publishes the result to the store the repository layer reads', async () => {
    signedIn();
    await refreshAuthority();

    const state = useSessionStore.getState();
    expect(state.actorId).toBe('u1');
    expect(state.authority.mode).toBe('granted');
  });

  it('takes the role from the database, never from the persisted session', async () => {
    // A device can edit its own localStorage; the only thing it can claim is *which existing
    // user* it is, and that user's real grants are then applied.
    useSessionStore.setState({
      session: { userId: 'u1', displayName: 'Sam', signedInAt: 0, roleId: 'administrator' } as never,
    });
    await refreshAuthority();

    expect(useSessionStore.getState().authority).toEqual({
      mode: 'granted',
      grants: new Set(['items:read', 'items:write']),
    });
  });
});

describe('adoptAuthorityChange', () => {
  it('re-resolves the session before the caches are dropped', async () => {
    // Order is the point (issue #631). A refetch that runs first would be answered under the
    // permissions being replaced, and its rows would then be cached as if they had been read
    // under the new ones.
    const order: string[] = [];
    getById.mockImplementation(async () => {
      order.push('resolve');
      return USER;
    });
    const client = {
      invalidateQueries: vi.fn(async () => {
        order.push('invalidate');
      }),
    };
    signedIn();

    await adoptAuthorityChange(client as never);

    expect(order).toEqual(['resolve', 'invalidate']);
    expect(useSessionStore.getState().authority.mode).toBe('granted');
  });

  it('adopts an account deleted elsewhere as a denial, not as Admin', async () => {
    // The sync/restore case the issue describes: the row is simply gone by the time this runs.
    getById.mockResolvedValue(undefined);
    signedIn('deleted-user');

    await adoptAuthorityChange({ invalidateQueries: vi.fn().mockResolvedValue(undefined) } as never);

    expect(useSessionStore.getState().authority).toEqual({ mode: 'denied', reason: 'signed-out' });
  });
});
