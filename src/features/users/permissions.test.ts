/**
 * Permission-engine tests (issue #79, plan §2.3, §3).
 *
 * The engine is the whole of the enforcement decision — the repository guards and the Bridge
 * routes only ask it questions — so the cases that matter most here are the ones where
 * getting it wrong fails *open*: single-user mode, the built-in principals, and a disabled
 * account.
 */
import { describe, expect, it } from 'vitest';
import {
  UNRESTRICTED_AUTHORITY,
  can,
  canAll,
  canAny,
  canTouchSubject,
  normaliseGrants,
  resolveAuthority,
  type Authority,
} from './permissions';

const granted = (...grants: readonly string[]): Authority => ({ mode: 'granted', grants: new Set(grants) });

describe('resolveAuthority', () => {
  it('is unrestricted when the users module is off — single-user mode is unchanged Gubbins', () => {
    expect(resolveAuthority({ moduleEnabled: false })).toEqual(UNRESTRICTED_AUTHORITY);
    // …even with a restricted user somehow present: the module being off is the whole answer.
    expect(
      resolveAuthority({
        moduleEnabled: false,
        user: { id: 'u1', kind: 'normal', isEnabled: true },
        grants: ['items:read'],
      }),
    ).toEqual(UNRESTRICTED_AUTHORITY);
  });

  it('denies a signed-out session once the module is on', () => {
    expect(resolveAuthority({ moduleEnabled: true })).toEqual({ mode: 'denied', reason: 'signed-out' });
  });

  it('makes the built-in Admin unrestricted', () => {
    expect(
      resolveAuthority({ moduleEnabled: true, user: { id: 'a', kind: 'admin', isEnabled: true } }),
    ).toEqual(UNRESTRICTED_AUTHORITY);
  });

  it('makes the built-in System user unrestricted despite being stored disabled', () => {
    // System is seeded `is_enabled = 0` — it can never sign in, but it is the actor the app
    // itself writes as. Checking `isEnabled` before `kind` would leave maintenance and sync
    // reconciliation unable to write anything at all.
    expect(
      resolveAuthority({ moduleEnabled: true, user: { id: 's', kind: 'system', isEnabled: false } }),
    ).toEqual(UNRESTRICTED_AUTHORITY);
  });

  it('denies a disabled ordinary user, whatever their role grants', () => {
    expect(
      resolveAuthority({
        moduleEnabled: true,
        user: { id: 'u1', kind: 'normal', isEnabled: false },
        grants: ['*'],
      }),
    ).toEqual({ mode: 'denied', reason: 'disabled' });
  });

  it('denies an ordinary user with no role', () => {
    const user = { id: 'u1', kind: 'normal', isEnabled: true } as const;
    expect(resolveAuthority({ moduleEnabled: true, user })).toEqual({ mode: 'denied', reason: 'no-role' });
  });

  it('distinguishes a role that grants nothing from having no role at all', () => {
    // Both deny everything, but only one is fixed by assigning a role — telling an operator
    // to assign a role they already assigned is worse advice than none.
    const user = { id: 'u1', kind: 'normal', isEnabled: true } as const;
    expect(resolveAuthority({ moduleEnabled: true, user, grants: [] })).toEqual({
      mode: 'denied',
      reason: 'no-permissions',
    });
  });

  it('carries an ordinary user’s grants through verbatim', () => {
    const authority = resolveAuthority({
      moduleEnabled: true,
      user: { id: 'u1', kind: 'normal', isEnabled: true },
      grants: ['items:read', 'items:write'],
    });
    expect(authority).toEqual(granted('items:read', 'items:write'));
  });
});

describe('can', () => {
  it('permits everything when unrestricted and nothing when denied', () => {
    expect(can(UNRESTRICTED_AUTHORITY, 'users:manage')).toBe(true);
    expect(can({ mode: 'denied', reason: 'disabled' }, 'items:read')).toBe(false);
  });

  it('matches an exact key', () => {
    const authority = granted('items:write');
    expect(can(authority, 'items:write')).toBe(true);
    expect(can(authority, 'items:delete')).toBe(false);
    expect(can(authority, 'items:read')).toBe(false);
  });

  it('matches a subject wildcard', () => {
    const authority = granted('items:*');
    expect(can(authority, 'items:read')).toBe(true);
    expect(can(authority, 'items:delete')).toBe(true);
    expect(can(authority, 'stock:write')).toBe(false);
  });

  it('matches the global wildcard, including keys added after the role was written', () => {
    const authority = granted('*');
    expect(can(authority, 'items:delete')).toBe(true);
    expect(can(authority, 'users:manage')).toBe(true);
    expect(can(authority, 'audit:view')).toBe(true);
  });

  it('never lets a wildcard for one subject leak into a similarly-named one', () => {
    // `items:*` must not satisfy anything under a subject that merely starts the same way.
    expect(can(granted('purchase-orders:*'), 'purchase-orders:delete')).toBe(true);
    expect(can(granted('purchase-orders:*'), 'projects:delete')).toBe(false);
  });

  it('ignores grants it does not recognise rather than treating them as wildcards', () => {
    const authority = granted('sorcery:read', 'items:teleport', 'nonsense');
    expect(can(authority, 'items:read')).toBe(false);
    expect(can(authority, 'items:write')).toBe(false);
  });
});

describe('canAll / canAny', () => {
  const authority = granted('items:read', 'stock:write');

  it('canAll requires every key, and is vacuously true for none', () => {
    expect(canAll(authority, ['items:read', 'stock:write'])).toBe(true);
    expect(canAll(authority, ['items:read', 'items:delete'])).toBe(false);
    expect(canAll(authority, [])).toBe(true);
  });

  it('canAny requires one key, and is false for none', () => {
    expect(canAny(authority, ['items:delete', 'stock:write'])).toBe(true);
    expect(canAny(authority, ['items:delete', 'users:manage'])).toBe(false);
    expect(canAny(authority, [])).toBe(false);
  });
});

describe('canTouchSubject', () => {
  it('answers whether anything at all is permitted on a subject', () => {
    expect(canTouchSubject(granted('items:read'), 'items')).toBe(true);
    expect(canTouchSubject(granted('items:read'), 'stock')).toBe(false);
    expect(canTouchSubject(granted('stock:*'), 'stock')).toBe(true);
    expect(canTouchSubject(granted('*'), 'users')).toBe(true);
  });

  it('follows the authority modes', () => {
    expect(canTouchSubject(UNRESTRICTED_AUTHORITY, 'users')).toBe(true);
    expect(canTouchSubject({ mode: 'denied', reason: 'signed-out' }, 'items')).toBe(false);
  });
});

describe('normaliseGrants', () => {
  it('trims, de-duplicates and orders deterministically', () => {
    expect(normaliseGrants([' items:write ', 'items:read', 'items:write', ''])).toEqual([
      'items:read',
      'items:write',
    ]);
  });

  it('keeps grants it does not recognise, sorted after the known ones', () => {
    // A peer on a newer Gubbins can sync a role holding a key this build has never heard of.
    // Editing that role here must not quietly strip the permission it gave.
    expect(normaliseGrants(['zebra:future', 'items:read'])).toEqual(['items:read', 'zebra:future']);
  });

  it('produces the same output regardless of input order', () => {
    const a = normaliseGrants(['stock:write', 'items:read', '*']);
    const b = normaliseGrants(['*', 'stock:write', 'items:read']);
    expect(a).toEqual(b);
  });
});
