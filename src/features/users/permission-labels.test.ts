/**
 * Copy-coverage guard for the permission registry (issue #429).
 *
 * Every key `permission-labels.ts` builds is interpolated from a registry slug and cast to a
 * `MessageKey`, which the type system cannot follow into `en.json`. Before this test, adding a
 * subject to `PERMISSION_SUBJECTS` compiled, shipped, and rendered the literal string
 * `users.subject.storage` in the role editor — a defect only a human reading the dialog would
 * catch, and only if they happened to open it.
 *
 * So assert the identity the cast asserts: for every subject, action and column slot the
 * registry declares, the English catalog holds a label *and* — where the editor shows one — a
 * help entry. German coverage is enforced separately and generally by `catalogs.test.ts`, which
 * requires every English key to be present in every shipped catalog.
 */
import { describe, expect, it } from 'vitest';
import { EN_CATALOG } from '@/features/i18n/messages';
import {
  PERMISSION_ACTION_SLOTS,
  PERMISSION_ACTION_SLOT_IDS,
  PERMISSION_KEYS,
  PERMISSION_SUBJECTS,
  PERMISSION_SUBJECT_IDS,
  actionSlot,
  permissionKeyInSlot,
  splitGrant,
  type PermissionAction,
} from './permission-registry';
import {
  actionLabelKey,
  permissionLabelKeys,
  slotHelpKey,
  slotLabelKey,
  subjectHelpKey,
  subjectLabelKey,
} from './permission-labels';

/**
 * Every distinct action any subject declares. Derived here rather than exported from the registry:
 * the registry itself never needs the list — it works subject by subject — so an export would be
 * production code with only a test to reach it.
 */
const DECLARED_ACTIONS: readonly string[] = [
  ...new Set(PERMISSION_SUBJECT_IDS.flatMap((subject) => PERMISSION_SUBJECTS[subject].actions)),
];

/** A catalog entry that is present and is a non-empty string. */
function expectCopy(key: string, because: string): void {
  const value = EN_CATALOG[key];
  expect(typeof value, `${because} (${key})`).toBe('string');
  expect((value ?? '').trim().length, `${because} (${key})`).toBeGreaterThan(0);
}

describe('permission copy coverage', () => {
  it('gives every subject a label and a help entry', () => {
    for (const subject of PERMISSION_SUBJECT_IDS) {
      expectCopy(subjectLabelKey(subject), `subject ${subject} has no label`);
      expectCopy(subjectHelpKey(subject), `subject ${subject} has no help`);
    }
  });

  it('gives every declared action a label', () => {
    for (const action of DECLARED_ACTIONS) {
      expectCopy(actionLabelKey(action as PermissionAction), `action ${action} has no label`);
    }
  });

  it('gives every column slot a label and a help entry', () => {
    for (const slot of PERMISSION_ACTION_SLOT_IDS) {
      expectCopy(slotLabelKey(slot), `slot ${slot} has no label`);
      expectCopy(slotHelpKey(slot), `slot ${slot} has no help`);
    }
  });

  it('names both halves of every permission key, for the refusal interstitial', () => {
    for (const key of PERMISSION_KEYS) {
      const [subjectKey, actionKey] = permissionLabelKeys(key);
      expectCopy(subjectKey, `${key} has no subject label`);
      expectCopy(actionKey, `${key} has no action label`);
    }
  });
});

describe('permission action slots', () => {
  it('places every action a subject declares in a column', () => {
    for (const subject of PERMISSION_SUBJECT_IDS) {
      for (const action of PERMISSION_SUBJECTS[subject].actions) {
        // An unplaced action would render no checkbox at all, and a missing box reads as
        // "this role cannot" rather than "this build forgot".
        expect(actionSlot(action), `${subject}:${action} has no column`).toBeDefined();
      }
    }
  });

  it('never puts two of one subject’s actions in the same column', () => {
    for (const subject of PERMISSION_SUBJECT_IDS) {
      const slots = PERMISSION_SUBJECTS[subject].actions.map((action) => actionSlot(action));
      expect(new Set(slots).size, `${subject} collides in a column`).toBe(slots.length);
    }
  });

  it('resolves a subject’s key per slot, and nothing where it has no such action', () => {
    expect(permissionKeyInSlot('items', 'view')).toBe('items:read');
    expect(permissionKeyInSlot('items', 'change')).toBe('items:write');
    expect(permissionKeyInSlot('items', 'delete')).toBe('items:delete');

    // The row that motivated slot columns: the audit trail's Delete must not land in the
    // column Items uses for Change.
    expect(permissionKeyInSlot('audit', 'view')).toBe('audit:view');
    expect(permissionKeyInSlot('audit', 'change')).toBeUndefined();
    expect(permissionKeyInSlot('audit', 'delete')).toBe('audit:delete');

    expect(permissionKeyInSlot('users', 'change')).toBe('users:manage');
    expect(permissionKeyInSlot('import', 'change')).toBe('import:run');
    expect(permissionKeyInSlot('labels', 'change')).toBe('labels:print');
    expect(permissionKeyInSlot('stock', 'delete')).toBeUndefined();
  });

  it('accounts for every key exactly once across the three columns', () => {
    const placed = PERMISSION_SUBJECT_IDS.flatMap((subject) =>
      PERMISSION_ACTION_SLOT_IDS.map((slot) => permissionKeyInSlot(subject, slot)).filter(Boolean),
    );
    expect(new Set(placed)).toEqual(new Set(PERMISSION_KEYS));
  });

  it('keeps the slot map free of actions no subject declares', () => {
    const declared = new Set(DECLARED_ACTIONS);
    for (const action of Object.keys(PERMISSION_ACTION_SLOTS)) {
      expect(declared.has(action), `${action} is placed but never declared`).toBe(true);
    }
  });

  it('captions only the actions whose own word differs from their column', () => {
    // The role editor shows a caption beneath a box exactly when these two differ, so this is
    // the list of cells a reader will see labelled.
    const captioned = PERMISSION_KEYS.filter((key) => {
      const [, action] = splitGrant(key);
      const slot = actionSlot(action);
      return (
        slot !== undefined &&
        EN_CATALOG[actionLabelKey(action as PermissionAction)] !== EN_CATALOG[slotLabelKey(slot)]
      );
    });
    expect(captioned).toEqual(['import:run', 'export:run', 'labels:print', 'users:manage']);
  });
});
