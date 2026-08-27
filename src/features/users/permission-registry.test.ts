/**
 * Registry-integrity tests (issue #79, plan §2.3).
 *
 * These guard the properties the rest of the engine assumes: that the runtime key list and
 * the compile-time union agree, and that the persisted slugs stay well-formed. A key is
 * stored inside `roles.permissions` JSON, so a malformed or renamed one silently strips a
 * grant from every role holding it — the kind of drift a test catches and review does not.
 */
import { describe, expect, it } from 'vitest';
import {
  GRANT_ALL,
  PERMISSION_KEYS,
  PERMISSION_SUBJECTS,
  PERMISSION_SUBJECT_IDS,
  isPermissionGrant,
  isPermissionKey,
  permissionKeysFor,
  splitGrant,
  type PermissionSubject,
} from './permission-registry';

describe('permission registry', () => {
  it('derives one key per subject/action pair', () => {
    const expected = PERMISSION_SUBJECT_IDS.reduce(
      (total, subject) => total + PERMISSION_SUBJECTS[subject].actions.length,
      0,
    );
    expect(PERMISSION_KEYS).toHaveLength(expected);
    expect(new Set(PERMISSION_KEYS).size).toBe(PERMISSION_KEYS.length);
  });

  it('keeps every subject slug kebab-case and every action lower-case', () => {
    for (const subject of PERMISSION_SUBJECT_IDS) {
      expect(subject).toMatch(/^[a-z]+(-[a-z]+)*$/);
      for (const action of PERMISSION_SUBJECTS[subject].actions) {
        expect(action).toMatch(/^[a-z]+$/);
      }
    }
  });

  it('gives every subject at least one action, with no duplicates', () => {
    for (const subject of PERMISSION_SUBJECT_IDS) {
      const actions = PERMISSION_SUBJECTS[subject].actions;
      expect(actions.length).toBeGreaterThan(0);
      expect(new Set(actions).size).toBe(actions.length);
    }
  });

  it('recognises exactly the keys it declares', () => {
    for (const key of PERMISSION_KEYS) {
      expect(isPermissionKey(key)).toBe(true);
    }
    expect(isPermissionKey('items:teleport')).toBe(false);
    expect(isPermissionKey('sorcery:read')).toBe(false);
    expect(isPermissionKey('items')).toBe(false);
    expect(isPermissionKey('')).toBe(false);
  });

  it('accepts wildcards as grants but not as keys', () => {
    expect(isPermissionGrant(GRANT_ALL)).toBe(true);
    expect(isPermissionGrant('items:*')).toBe(true);
    expect(isPermissionKey('items:*')).toBe(false);
    expect(isPermissionGrant('sorcery:*')).toBe(false);
  });

  it('splits grants, and reports malformed ones as empty', () => {
    expect(splitGrant('items:write')).toEqual(['items', 'write']);
    expect(splitGrant('purchase-orders:delete')).toEqual(['purchase-orders', 'delete']);
    expect(splitGrant('items')).toEqual(['', '']);
    expect(splitGrant(':write')).toEqual(['', '']);
    expect(splitGrant('items:')).toEqual(['', '']);
  });

  it("lists a subject's keys in declaration order", () => {
    expect(permissionKeysFor('items')).toEqual(['items:read', 'items:write', 'items:delete']);
    expect(permissionKeysFor('reports')).toEqual(['reports:read']);
  });

  it('models the subjects whose actions are deliberately not read/write/delete', () => {
    // The audit trail is immutable, so it is viewed and pruned — never "written".
    expect(PERMISSION_SUBJECTS.audit.actions).toEqual(['view', 'delete']);
    // Account administration is not usefully divisible: anyone who can edit an account can
    // grant themselves a role, so a separate `users:delete` would be no extra protection.
    expect(PERMISSION_SUBJECTS.users.actions).toEqual(['read', 'manage']);
    // Stock is written down or written off, never deleted.
    expect(PERMISSION_SUBJECTS.stock.actions).toEqual(['read', 'write']);
    // A bulk capability is named for what it does; "change" describes none of these.
    expect(PERMISSION_SUBJECTS.import.actions).toEqual(['run']);
    expect(PERMISSION_SUBJECTS.export.actions).toEqual(['run']);
    expect(PERMISSION_SUBJECTS.labels.actions).toEqual(['print']);
  });

  it('lets a loan raised in error be deleted, not merely checked back in', () => {
    // Before issue #429 `checkouts` had no delete, and the danger zone erased every loan on
    // `checkouts:write` — so a role trusted to hand equipment out could also wipe the record
    // of every loan ever made.
    expect(PERMISSION_SUBJECTS.checkouts.actions).toEqual(['read', 'write', 'delete']);
  });

  it('keeps the capabilities that gate the app itself distinct from the records inside it', () => {
    // `modules` is the permission that protects the permission system: switching the Users
    // module off takes the sign-in gate with it.
    expect(PERMISSION_SUBJECTS.modules.actions).toEqual(['read', 'write']);
    // `storage` is housekeeping the database; `maintenance` is servicing an asset. Two very
    // different jobs that a single word would have merged.
    expect(PERMISSION_SUBJECTS.storage.actions).toEqual(['read', 'write']);
    expect(PERMISSION_SUBJECTS.storage.kind).toBe('capability');
    expect(PERMISSION_SUBJECTS.maintenance.kind).toBe('entity');
  });

  it('keeps stock separate from items, which is what makes a Stocker role possible', () => {
    const subjects: readonly PermissionSubject[] = PERMISSION_SUBJECT_IDS;
    expect(subjects).toContain('items');
    expect(subjects).toContain('stock');
  });
});
