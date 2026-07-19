/**
 * The roles Gubbins ships with (issue #79, plan §2.3).
 *
 * These are seeded by the `v1-initial` baseline — which imports this module, so the roles in
 * a fresh database and the roles described here can never drift. Phase 1 deliberately left
 * them unseeded: their contents are permission keys, and the registry defining those keys is
 * this phase, so seeding earlier would have baked a guess into the baseline.
 *
 * Built-in roles are **editable but not deletable** (plan §2.3): an operator may retune what
 * "Stocker" grants, but removing it outright would strand every user assigned to it. Editing
 * one changes only that database's copy — the definitions here are the starting point, not a
 * contract the app re-asserts on every boot.
 *
 * ⚠️ **Editing this file resets every existing database.** The baseline seeds these rows
 * through bound parameters, and `baselineFingerprint` hashes parameters as well as SQL, so
 * changing a name, description or grant list shifts the fingerprint and boot refuses the
 * on-disk database with `SCHEMA_STALE`. That is correct pre-release — the baseline genuinely
 * did change — but it means a one-word description fix costs every user their local data, and
 * a *new permission subject* does it silently, because Manager's grants are generated from
 * the subject list. Weigh that before editing, and expect it to become a real migration
 * problem rather than a free one once Gubbins is past 1.0.
 */
import {
  GRANT_ALL,
  PERMISSION_SUBJECT_IDS,
  type PermissionGrant,
  type PermissionSubject,
} from './permission-registry';

/**
 * A role shipped with Gubbins. `id` is a deliberately *constant* UUIDv4 for the same reason
 * the built-in user ids are (see `SYSTEM_USER_ID`): every device seeds these rows
 * independently, and a per-device id would produce four duplicate roles the first time two
 * devices synced.
 */
export interface BuiltinRoleDef {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly grants: readonly PermissionGrant[];
}

/** Every subject bar `users` — the shape of "everything except account administration". */
function subjectWildcardsExcept(...excluded: readonly PermissionSubject[]): readonly PermissionGrant[] {
  return PERMISSION_SUBJECT_IDS.filter((subject) => !excluded.includes(subject)).map(
    (subject) => `${subject}:*` as PermissionGrant,
  );
}

export const ADMINISTRATOR_ROLE_ID = '00000000-0000-4000-8000-000000000020';
export const MANAGER_ROLE_ID = '00000000-0000-4000-8000-000000000021';
export const STOCKER_ROLE_ID = '00000000-0000-4000-8000-000000000022';
export const VIEWER_ROLE_ID = '00000000-0000-4000-8000-000000000023';

/**
 * The four built-in roles, in the order an admin list shows them (most to least privileged).
 *
 * **Administrator holds the global wildcard rather than an enumeration of today's keys.** A
 * role defined as "everything" must keep meaning everything after a later release adds a
 * permission, and a list frozen into the baseline would not. The other three enumerate
 * deliberately: a new capability should *not* silently reach a restricted role, so
 * broadening them is an explicit decision taken when the capability ships.
 */
export const BUILTIN_ROLES: readonly BuiltinRoleDef[] = [
  {
    id: ADMINISTRATOR_ROLE_ID,
    name: 'Administrator',
    description: 'Full access to everything, including managing users and roles.',
    grants: [GRANT_ALL],
  },
  {
    id: MANAGER_ROLE_ID,
    name: 'Manager',
    description: 'Full access to inventory, projects and settings, but cannot manage users.',
    grants: [...subjectWildcardsExcept('users'), 'users:read'],
  },
  {
    id: STOCKER_ROLE_ID,
    name: 'Stocker',
    description:
      'Can add and edit items, move stock and run counts, but cannot delete or see the audit trail.',
    grants: [
      'items:read',
      'items:write',
      'stock:read',
      'stock:write',
      'locations:read',
      'locations:write',
      'categories:read',
      'tags:read',
      'tags:write',
      'checkouts:read',
      'checkouts:write',
      'maintenance:read',
      'reports:read',
    ],
  },
  {
    id: VIEWER_ROLE_ID,
    name: 'Viewer',
    description:
      'Can look at everything except the audit trail and user accounts, but cannot change anything.',
    grants: [
      'items:read',
      'stock:read',
      'locations:read',
      'categories:read',
      'tags:read',
      'projects:read',
      'contacts:read',
      'suppliers:read',
      'purchase-orders:read',
      'bookings:read',
      'checkouts:read',
      'maintenance:read',
      'wishlist:read',
      'reports:read',
    ],
  },
];

/** The seeded role ids, for the guards and tests that need to recognise them. */
export const BUILTIN_ROLE_IDS: readonly string[] = BUILTIN_ROLES.map((role) => role.id);
