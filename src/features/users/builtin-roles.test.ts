/**
 * Built-in role tests (issue #79, plan §2.3).
 *
 * The roles are seeded into the `v1-initial` baseline, so a mistake here ships in every fresh
 * database rather than being fixable by an edit. These assert the shape the plan describes —
 * and, more usefully, assert what each role can and cannot actually *do* by running its
 * grants through the real engine rather than by comparing string lists.
 */
import { describe, expect, it } from 'vitest';
import { BUILTIN_ROLES, BUILTIN_ROLE_IDS } from './builtin-roles';
import { PERMISSION_KEYS, isPermissionGrant } from './permission-registry';
import { can, resolveAuthority, type Authority } from './permissions';

/** The authority an ordinary, enabled user assigned `roleName` would resolve to. */
function authorityFor(roleName: string): Authority {
  const role = BUILTIN_ROLES.find((candidate) => candidate.name === roleName);
  if (!role) throw new Error(`No built-in role named "${roleName}".`);
  return resolveAuthority({
    moduleEnabled: true,
    user: { id: 'u1', kind: 'normal', isEnabled: true },
    grants: role.grants,
  });
}

describe('built-in roles', () => {
  it('ships the four roles the plan names, most privileged first', () => {
    expect(BUILTIN_ROLES.map((role) => role.name)).toEqual(['Administrator', 'Manager', 'Stocker', 'Viewer']);
  });

  it('gives every role a constant, unique, well-formed id', () => {
    for (const id of BUILTIN_ROLE_IDS) {
      expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    }
    expect(new Set(BUILTIN_ROLE_IDS).size).toBe(BUILTIN_ROLE_IDS.length);
  });

  it('grants only things the registry recognises', () => {
    for (const role of BUILTIN_ROLES) {
      for (const grant of role.grants) {
        expect(isPermissionGrant(grant)).toBe(true);
      }
    }
  });

  it('gives every role a description, so the admin UI never shows a bare name', () => {
    for (const role of BUILTIN_ROLES) {
      expect(role.description.length).toBeGreaterThan(0);
    }
  });

  describe('Administrator', () => {
    it('permits every key in the registry', () => {
      const authority = authorityFor('Administrator');
      for (const key of PERMISSION_KEYS) {
        expect(can(authority, key)).toBe(true);
      }
    });

    it('holds the global wildcard, so a key added by a later release still reaches it', () => {
      // Enumerating today's keys into the baseline would leave the one role defined as
      // "everything" quietly short of a permission the next version introduces.
      expect(BUILTIN_ROLES[0].grants).toEqual(['*']);
    });
  });

  describe('Manager', () => {
    const authority = authorityFor('Manager');

    it('permits everything bar managing accounts', () => {
      for (const key of PERMISSION_KEYS) {
        expect(can(authority, key)).toBe(key !== 'users:manage');
      }
    });

    it('can still see who the users are', () => {
      expect(can(authority, 'users:read')).toBe(true);
    });
  });

  describe('Stocker', () => {
    const authority = authorityFor('Stocker');

    it('can add and edit items and move stock', () => {
      expect(can(authority, 'items:write')).toBe(true);
      expect(can(authority, 'stock:write')).toBe(true);
      expect(can(authority, 'locations:write')).toBe(true);
    });

    it('cannot delete anything', () => {
      for (const key of PERMISSION_KEYS) {
        if (key.endsWith(':delete')) expect(can(authority, key)).toBe(false);
      }
    });

    it('cannot see the audit trail or manage accounts', () => {
      expect(can(authority, 'audit:view')).toBe(false);
      expect(can(authority, 'users:manage')).toBe(false);
      expect(can(authority, 'users:read')).toBe(false);
    });
  });

  describe('Viewer', () => {
    const authority = authorityFor('Viewer');

    it('permits nothing that changes anything', () => {
      for (const key of PERMISSION_KEYS) {
        if (!key.endsWith(':read')) expect(can(authority, key)).toBe(false);
      }
    });

    it('can read the ordinary catalogue', () => {
      expect(can(authority, 'items:read')).toBe(true);
      expect(can(authority, 'projects:read')).toBe(true);
      expect(can(authority, 'reports:read')).toBe(true);
    });

    it('cannot see the audit trail or the list of accounts', () => {
      expect(can(authority, 'audit:view')).toBe(false);
      expect(can(authority, 'users:read')).toBe(false);
    });
  });
});
