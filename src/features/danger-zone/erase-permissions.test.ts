/**
 * The Danger-Zone erase is inside the permission boundary (issue #519).
 *
 * The erase composes its own SQL and hands it to the driver, so `BaseRepository.assertPermission`
 * — the check that refuses a Viewer a single item — never sees it. Before this, the account that
 * could not delete one item could tick "Items" and delete the catalogue. These assert the guard
 * that closes it, and that it refuses *before* anything is removed rather than part-way through.
 */
import { describe, it, expect, vi } from 'vitest';
import { PERMISSION_KEYS, type PermissionKey } from '@/features/users/permission-registry';
import { VIEWER_ROLE_ID, BUILTIN_ROLES, STOCKER_ROLE_ID } from '@/features/users/builtin-roles';
import { resolveAuthority, UNRESTRICTED_AUTHORITY, type Authority } from '@/features/users/permissions';
import type { IDatabaseDriver } from '@/db/rpc/driver';
import { DbError } from '@/db/errors';
import { ERASE_EVERYTHING_PERMISSIONS, ERASE_TARGETS } from './erase-targets';
import {
  assertMayErase,
  assertMayEraseEverything,
  eraseTargets,
  mayEraseTarget,
  type ErasePorts,
} from './erase-actions';

/** The authority a signed-in holder of one of the built-in roles resolves to. */
function builtinAuthority(roleId: string): Authority {
  const role = BUILTIN_ROLES.find((r) => r.id === roleId)!;
  return resolveAuthority({
    moduleEnabled: true,
    user: { id: 'user-1', kind: 'normal', isEnabled: true },
    grants: role.grants,
  });
}

/** A minimal in-memory Storage stand-in, so a refused erase can be shown to touch nothing. */
function fakeStorage(initial: Record<string, string> = {}): Storage {
  const map = new Map<string, string>(Object.entries(initial));
  return {
    get length() {
      return map.size;
    },
    clear: () => map.clear(),
    getItem: (key: string) => (map.has(key) ? (map.get(key) as string) : null),
    key: (index: number) => [...map.keys()][index] ?? null,
    removeItem: (key: string) => {
      map.delete(key);
    },
    setItem: (key: string, value: string) => {
      map.set(key, value);
    },
  } as Storage;
}

/** Ports whose every side effect is a spy, so "nothing happened" is assertable. */
function spyPorts(authority: Authority, local = fakeStorage({ 'gubbins:layout': '{}' })) {
  const transaction = vi.fn(async () => undefined);
  const removeImagesDirectory = vi.fn(async () => undefined);
  const deleteIdb = vi.fn(async () => undefined);
  const ports: ErasePorts = {
    db: { transaction } as unknown as IDatabaseDriver,
    removeImagesDirectory,
    local,
    deleteIdb,
    authority: () => authority,
  };
  return { ports, transaction, removeImagesDirectory, deleteIdb, local };
}

describe('the erase catalog declares what it needs', () => {
  it('gives every target at least one permission, and only keys the registry knows', () => {
    const known = new Set<string>(PERMISSION_KEYS);
    for (const target of ERASE_TARGETS) {
      expect(target.permissions.length, `${target.id} declares no permission`).toBeGreaterThan(0);
      for (const key of target.permissions) {
        expect(known.has(key), `${target.id} names an unknown permission (${key})`).toBe(true);
      }
    }
  });

  it('asks the factory reset for everything the individual targets ask for', () => {
    const union = new Set<PermissionKey>(ERASE_TARGETS.flatMap((target) => target.permissions));
    expect(new Set(ERASE_EVERYTHING_PERMISSIONS)).toEqual(union);
  });
});

describe('eraseTargets refuses what the repositories refuse', () => {
  it('lets an unrestricted session (single-user mode) erase anything', async () => {
    const { ports, transaction } = spyPorts(UNRESTRICTED_AUTHORITY);
    await expect(eraseTargets(['items'], { tombstone: false }, ports)).resolves.toEqual({
      erased: ['items'],
    });
    expect(transaction).toHaveBeenCalledOnce();
  });

  it('refuses a Viewer the whole catalogue, exactly as it refuses them one item', async () => {
    const viewer = builtinAuthority(VIEWER_ROLE_ID);
    expect(mayEraseTarget(viewer, 'items')).toBe(false);

    const { ports, transaction, removeImagesDirectory } = spyPorts(viewer);
    await expect(eraseTargets(['items'], { tombstone: false }, ports)).rejects.toMatchObject({
      code: 'PERMISSION_DENIED',
    });
    expect(transaction).not.toHaveBeenCalled();
    expect(removeImagesDirectory).not.toHaveBeenCalled();
  });

  it('refuses a Stocker, who may write items but not delete them', () => {
    const stocker = builtinAuthority(STOCKER_ROLE_ID);
    expect(mayEraseTarget(stocker, 'items')).toBe(false);
    expect(() => assertMayErase(stocker, ['items'])).toThrow(DbError);
  });

  it('removes nothing at all when one target of several is refused', async () => {
    // `items:delete` alone: enough for the first target, not for the local one beside it.
    const authority: Authority = { mode: 'granted', grants: new Set(['items:delete']) };
    const { ports, transaction, local } = spyPorts(authority);

    await expect(
      eraseTargets(['items', 'dashboard-layout'], { tombstone: false }, ports),
    ).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });

    expect(transaction).not.toHaveBeenCalled();
    expect(local.getItem('gubbins:layout')).toBe('{}');
  });

  it('erases a local target the role does hold the key for', async () => {
    const authority: Authority = { mode: 'granted', grants: new Set(['settings:write']) };
    const { ports, local } = spyPorts(authority);
    await eraseTargets(['dashboard-layout'], { tombstone: false }, ports);
    expect(local.getItem('gubbins:layout')).toBeNull();
  });

  it('ignores an id it has never heard of rather than refusing the ids beside it', () => {
    const authority: Authority = { mode: 'granted', grants: new Set(['items:delete']) };
    // A target synced from a newer peer: nothing here can describe or erase it.
    const unknown = 'quantum-widgets' as never;
    expect(() => assertMayErase(authority, ['items', unknown])).not.toThrow();
    expect(mayEraseTarget(authority, unknown)).toBe(false);
  });
});

describe('the factory reset asks for more than any single target', () => {
  it('refuses a role that may erase some categories but not all of them', () => {
    const authority: Authority = { mode: 'granted', grants: new Set(['items:delete']) };
    expect(() => assertMayEraseEverything(authority)).toThrow(DbError);
  });

  it('permits an unrestricted session', () => {
    expect(() => assertMayEraseEverything(UNRESTRICTED_AUTHORITY)).not.toThrow();
  });
});
