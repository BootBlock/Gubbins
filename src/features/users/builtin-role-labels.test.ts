import { describe, expect, it } from 'vitest';
import type { MessageKey } from '@/features/i18n';
import { ADMINISTRATOR_ROLE_ID, BUILTIN_ROLES } from './builtin-roles';
import {
  builtinRoleDescription,
  builtinRoleDescriptionKey,
  builtinRoleName,
  builtinRoleNameKey,
  toStoredRoleText,
} from './builtin-role-labels';

const ADMIN = BUILTIN_ROLES.find((role) => role.id === ADMINISTRATOR_ROLE_ID)!;

/** A stand-in "German" catalog: every key resolves to itself prefixed, so drift is visible. */
const translate = (key: MessageKey): string => `de:${key}`;

const adminRow = {
  id: ADMINISTRATOR_ROLE_ID,
  name: ADMIN.name,
  description: ADMIN.description,
};

describe('builtinRoleName / builtinRoleDescription', () => {
  it('translates a built-in role whose row still holds the shipped English', () => {
    expect(builtinRoleName(adminRow, translate)).toBe(`de:${builtinRoleNameKey(ADMIN.id)}`);
    expect(builtinRoleDescription(adminRow, translate)).toBe(`de:${builtinRoleDescriptionKey(ADMIN.id)}`);
  });

  it('keeps a renamed built-in role in the operator’s own wording', () => {
    const renamed = { ...adminRow, name: 'Chief', description: 'Runs the place.' };
    expect(builtinRoleName(renamed, translate)).toBe('Chief');
    expect(builtinRoleDescription(renamed, translate)).toBe('Runs the place.');
  });

  it('translates each field independently', () => {
    const halfEdited = { ...adminRow, description: 'Runs the place.' };
    expect(builtinRoleName(halfEdited, translate)).toBe(`de:${builtinRoleNameKey(ADMIN.id)}`);
    expect(builtinRoleDescription(halfEdited, translate)).toBe('Runs the place.');
  });

  it('leaves a custom role alone entirely', () => {
    const custom = { id: 'custom-role', name: 'Auditor', description: null };
    expect(builtinRoleName(custom, translate)).toBe('Auditor');
    expect(builtinRoleDescription(custom, translate)).toBeNull();
  });

  it('shows no description when a built-in role has had its own cleared', () => {
    expect(builtinRoleDescription({ ...adminRow, description: null }, translate)).toBeNull();
  });
});

describe('toStoredRoleText', () => {
  it('folds an unedited built-in role back to the shipped English', () => {
    const submitted = {
      name: `de:${builtinRoleNameKey(ADMIN.id)}`,
      description: `de:${builtinRoleDescriptionKey(ADMIN.id)}`,
    };
    expect(toStoredRoleText(adminRow, submitted, translate)).toEqual({
      name: ADMIN.name,
      description: ADMIN.description,
    });
  });

  it('stores a genuine edit verbatim', () => {
    const submitted = { name: 'Chef', description: `de:${builtinRoleDescriptionKey(ADMIN.id)}` };
    expect(toStoredRoleText(adminRow, submitted, translate)).toEqual({
      name: 'Chef',
      description: ADMIN.description,
    });
  });

  it('never resurrects the default over a name the operator already changed', () => {
    const renamed = { ...adminRow, name: 'Chief' };
    expect(toStoredRoleText(renamed, { name: 'Chief', description: null }, translate).name).toBe('Chief');
  });

  it('passes a new or custom role straight through', () => {
    const values = { name: 'Auditor', description: null };
    expect(toStoredRoleText(null, values, translate)).toEqual(values);
    expect(toStoredRoleText({ id: 'custom', name: 'Auditor', description: null }, values, translate)).toEqual(
      values,
    );
  });
});
