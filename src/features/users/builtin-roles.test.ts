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
import { isGlyphName } from '@/components/foundry/glyph-picker/glyph-registry';
import { PERMISSION_KEYS, isPermissionGrant } from './permission-registry';
import { mayEraseTarget } from '@/features/danger-zone/erase-actions';
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
  it('ships the roles the plan names, broadly most privileged first', () => {
    expect(BUILTIN_ROLES.map((role) => role.name)).toEqual([
      'Administrator',
      'Manager',
      'Stocker',
      'Viewer',
      'Auditor',
      'Purchaser',
      'Technician',
      'Loans desk',
    ]);
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

  // A glyph name that is not in the catalogue does not fail — `Glyph` quietly falls back to the
  // default role icon — so a typo would ship looking exactly like a role that chose no icon.
  // This is the only thing that can tell the two apart before release (issue #431).
  it('gives every role an icon that is really in the glyph catalogue', () => {
    for (const role of BUILTIN_ROLES) {
      expect(isGlyphName(role.icon), `${role.name} → ${role.icon}`).toBe(true);
    }
  });

  it('gives each role a distinct icon, so a list of roles is readable at a glance', () => {
    const icons = BUILTIN_ROLES.map((role) => role.icon);
    expect(new Set(icons).size).toBe(icons.length);
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

    it('permits everything bar managing accounts and switching modules off', () => {
      const withheld = new Set(['users:manage', 'modules:write']);
      for (const key of PERMISSION_KEYS) {
        expect(can(authority, key), key).toBe(!withheld.has(key));
      }
    });

    it('can still see who the users are, and which modules are on', () => {
      expect(can(authority, 'users:read')).toBe(true);
      expect(can(authority, 'modules:read')).toBe(true);
    });

    it('cannot take the sign-in gate down, which is what withholding modules:write is for', () => {
      // Switching the Users module off disables the sign-in gate, so a Manager holding
      // `modules:write` could hand itself the very `users:manage` this role is defined without.
      expect(can(authority, 'modules:write')).toBe(false);
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

    it('cannot take the data away, which is what separates it from Auditor', () => {
      expect(can(authority, 'export:run')).toBe(false);
    });
  });

  describe('Auditor', () => {
    const authority = authorityFor('Auditor');

    it('sees the activity history Viewer cannot, and can export it', () => {
      expect(can(authority, 'audit:view')).toBe(true);
      expect(can(authority, 'export:run')).toBe(true);
      expect(can(authority, 'storage:read')).toBe(true);
    });

    it('changes nothing at all', () => {
      for (const key of PERMISSION_KEYS) {
        if (key.endsWith(':write') || key.endsWith(':delete') || key.endsWith(':manage')) {
          expect(can(authority, key), key).toBe(false);
        }
      }
    });

    it('cannot prune the ledger it audits', () => {
      expect(can(authority, 'audit:delete')).toBe(false);
    });
  });

  describe('Purchaser', () => {
    const authority = authorityFor('Purchaser');

    it('owns suppliers, purchase orders and the wishlist outright', () => {
      for (const subject of ['suppliers', 'purchase-orders', 'wishlist'] as const) {
        expect(can(authority, `${subject}:write`), subject).toBe(true);
        expect(can(authority, `${subject}:delete`), subject).toBe(true);
      }
    });

    it('can receive a delivery, which needs stock as well as the order', () => {
      expect(can(authority, 'purchase-orders:write')).toBe(true);
      expect(can(authority, 'stock:write')).toBe(true);
    });

    it('cannot delete an item, or reach accounts, modules or the bridge', () => {
      expect(can(authority, 'items:delete')).toBe(false);
      expect(can(authority, 'users:read')).toBe(false);
      expect(can(authority, 'modules:write')).toBe(false);
      expect(can(authority, 'bridge:read')).toBe(false);
    });
  });

  describe('Technician', () => {
    const authority = authorityFor('Technician');

    it('owns maintenance and can consume stock on a job', () => {
      expect(can(authority, 'maintenance:write')).toBe(true);
      expect(can(authority, 'maintenance:delete')).toBe(true);
      expect(can(authority, 'stock:write')).toBe(true);
      expect(can(authority, 'labels:print')).toBe(true);
    });

    it('leaves the catalogue read-only — servicing an asset is not rewriting its record', () => {
      expect(can(authority, 'items:read')).toBe(true);
      expect(can(authority, 'items:write')).toBe(false);
      expect(can(authority, 'items:delete')).toBe(false);
    });

    it('cannot cancel a loan outright, only check one in and out', () => {
      expect(can(authority, 'checkouts:write')).toBe(true);
      expect(can(authority, 'checkouts:delete')).toBe(false);
    });
  });

  describe('Loans desk', () => {
    const authority = authorityFor('Loans desk');

    it('owns the whole booking lifecycle, including one raised in error', () => {
      expect(can(authority, 'bookings:write')).toBe(true);
      expect(can(authority, 'bookings:delete')).toBe(true);
    });

    it('lends and returns, and can clear the loan ledger', () => {
      expect(can(authority, 'checkouts:write')).toBe(true);
      // `checkouts:delete` is the ledger, not one loan: no repository deletes a single checkout,
      // so its only enforcement point is the danger zone's Loans entry and the loans that go
      // with a deleted item. Asserting the *reachable* act keeps this honest — testing the grant
      // alone would only restate the list this role was built from.
      expect(mayEraseTarget(authority, 'checkouts')).toBe(true);
    });

    it('keeps borrower contacts, but never edits the catalogue', () => {
      expect(can(authority, 'contacts:write')).toBe(true);
      expect(can(authority, 'items:write')).toBe(false);
      expect(can(authority, 'stock:write')).toBe(false);
    });
  });

  describe('the job roles below Viewer', () => {
    const JOB_ROLES = ['Auditor', 'Purchaser', 'Technician', 'Loans desk'] as const;

    it('never reach the permissions that administer the device', () => {
      // Doing work in Gubbins and administering it are separate jobs. `modules` matters most:
      // a role that could write it could switch the sign-in gate off and escape the rest.
      const administrative = [
        'users:read',
        'users:manage',
        'modules:read',
        'modules:write',
        'settings:write',
        'backup:read',
        'backup:write',
        'sync:read',
        'sync:write',
        'bridge:read',
        'bridge:write',
      ] as const;
      for (const name of JOB_ROLES) {
        const authority = authorityFor(name);
        for (const key of administrative) {
          expect(can(authority, key), `${name} → ${key}`).toBe(false);
        }
      }
    });

    it('each grant something none of the original four does', () => {
      // A preset that is a strict subset of an existing role is a preset nobody would pick.
      const distinguishing = {
        Auditor: 'export:run',
        Purchaser: 'purchase-orders:delete',
        Technician: 'maintenance:delete',
        'Loans desk': 'checkouts:delete',
      } as const;
      for (const [name, key] of Object.entries(distinguishing)) {
        expect(can(authorityFor(name), key), `${name} → ${key}`).toBe(true);
        for (const other of ['Stocker', 'Viewer'] as const) {
          expect(can(authorityFor(other), key), `${other} → ${key}`).toBe(false);
        }
      }
    });
  });
});
