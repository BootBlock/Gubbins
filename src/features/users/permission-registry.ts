/**
 * Permission registry — the single source of truth for what may be permitted
 * (issue #79, plan §2.3).
 *
 * Every permission key in Gubbins is declared here, once, as a `<subject>:<action>` pair.
 * The pure engine (`permissions.ts`), the built-in roles (`builtin-roles.ts`), the
 * repository guards and the phase-4 admin UI all hang off this list — the same "one SSOT
 * record + pure maths over it" seam as `feature-registry.ts` and `nav-destinations.ts`.
 *
 * Two properties this module deliberately keeps:
 *
 * - **No React, no I/O, no `src/db` import.** The Bridge imports the engine to gate its
 *   routes (plan §1.3), and it loads TypeScript through Node's strip-only loader, so this
 *   file must also avoid `enum`, `namespace` and parameter properties.
 * - **No display copy.** Labels and descriptions are catalog keys, added alongside the
 *   admin UI in phase 4 (`users.permission.<key>`), so the English copy lives in exactly
 *   one place rather than being duplicated here and in `en.json`.
 */

/**
 * What a permission applies to. Subjects are either **entity types** (the things a user
 * creates and edits) or **cross-cutting capabilities** (things that aren't a row in a
 * table but are still worth withholding — the audit trail, the Bridge, backups).
 *
 * The slugs are persisted inside `roles.permissions` JSON, so they are effectively a
 * public enum: renaming one silently strips that grant from every role that holds it.
 */
export type PermissionSubjectKind = 'entity' | 'capability';

/** A subject's declaration: what kind of thing it is, and which actions it supports. */
export interface PermissionSubjectDef {
  readonly kind: PermissionSubjectKind;
  /**
   * The actions this subject supports. Most entities take the full `read`/`write`/`delete`
   * triple, but not all combinations are meaningful — a report cannot be written, and an
   * account is not part-managed — so each subject names its own rather than inheriting a
   * uniform set that would mint keys nothing can ever check.
   */
  readonly actions: readonly string[];
}

/**
 * Every subject, with the actions it supports.
 *
 * `stock` is deliberately separate from `items`: moving, adjusting and counting quantity is
 * a different capability from editing the item record itself, and the "Stocker" role exists
 * precisely to grant one without the other. It has no `delete` — stock is written down to
 * zero or written off, never deleted.
 *
 * `audit` uses `view`/`delete` rather than `read`/`write` because the ledger is immutable:
 * there is no such thing as writing an audit entry directly, and `delete` covers only
 * retention pruning.
 *
 * `users` uses `read`/`manage` because account administration is not usefully divisible —
 * anyone who can edit an account can grant themselves a role, so a separate `users:delete`
 * would be a distinction without a security difference.
 */
export const PERMISSION_SUBJECTS = {
  items: { kind: 'entity', actions: ['read', 'write', 'delete'] },
  stock: { kind: 'entity', actions: ['read', 'write'] },
  locations: { kind: 'entity', actions: ['read', 'write', 'delete'] },
  categories: { kind: 'entity', actions: ['read', 'write', 'delete'] },
  tags: { kind: 'entity', actions: ['read', 'write', 'delete'] },
  projects: { kind: 'entity', actions: ['read', 'write', 'delete'] },
  contacts: { kind: 'entity', actions: ['read', 'write', 'delete'] },
  suppliers: { kind: 'entity', actions: ['read', 'write', 'delete'] },
  'purchase-orders': { kind: 'entity', actions: ['read', 'write', 'delete'] },
  bookings: { kind: 'entity', actions: ['read', 'write', 'delete'] },
  checkouts: { kind: 'entity', actions: ['read', 'write'] },
  maintenance: { kind: 'entity', actions: ['read', 'write', 'delete'] },
  wishlist: { kind: 'entity', actions: ['read', 'write', 'delete'] },
  reports: { kind: 'capability', actions: ['read'] },
  audit: { kind: 'capability', actions: ['view', 'delete'] },
  settings: { kind: 'capability', actions: ['read', 'write'] },
  users: { kind: 'capability', actions: ['read', 'manage'] },
  backup: { kind: 'capability', actions: ['read', 'write'] },
  sync: { kind: 'capability', actions: ['read', 'write'] },
  bridge: { kind: 'capability', actions: ['read', 'write'] },
} as const satisfies Record<string, PermissionSubjectDef>;

/** A declared subject slug. */
export type PermissionSubject = keyof typeof PERMISSION_SUBJECTS;

/** Every subject slug, in declaration order. */
export const PERMISSION_SUBJECT_IDS = Object.keys(PERMISSION_SUBJECTS) as readonly PermissionSubject[];

/**
 * The closed union of permission keys, derived from {@link PERMISSION_SUBJECTS} so the type
 * and the runtime list can never disagree. Adding an action to a subject above is the only
 * way to mint a key.
 */
export type PermissionKey = {
  [S in PermissionSubject]: `${S}:${(typeof PERMISSION_SUBJECTS)[S]['actions'][number]}`;
}[PermissionSubject];

/** Every permission key, grouped by subject in declaration order. */
export const PERMISSION_KEYS: readonly PermissionKey[] = PERMISSION_SUBJECT_IDS.flatMap((subject) =>
  PERMISSION_SUBJECTS[subject].actions.map((action) => `${subject}:${action}` as PermissionKey),
);

/** Fast membership test for {@link isPermissionKey}, built once. */
const PERMISSION_KEY_SET: ReadonlySet<string> = new Set<string>(PERMISSION_KEYS);

/**
 * A **grant** is what a role actually stores, and is broader than a single key so that a
 * role does not silently fall behind the registry:
 *
 * - `'*'` — everything, including subjects added by a later version of Gubbins.
 * - `'<subject>:*'` — every action on one subject, present and future.
 * - a plain {@link PermissionKey}.
 *
 * The Administrator role holds `'*'` for exactly this reason: enumerating today's keys into
 * the baseline would mean a key added in a later release was not granted to the one role
 * that is defined as having everything.
 */
export type PermissionGrant = '*' | `${PermissionSubject}:*` | PermissionKey;

/** The grant that confers everything. */
export const GRANT_ALL = '*';

/** True when `value` is a permission key this build knows about. */
export function isPermissionKey(value: string): value is PermissionKey {
  return PERMISSION_KEY_SET.has(value);
}

/**
 * True when `value` is a grant this build can interpret — a key, a subject wildcard, or the
 * global wildcard.
 *
 * A grant read back from `roles.permissions` may legitimately be *unrecognised*: a peer
 * running a newer Gubbins can sync a role holding a key this build has never heard of.
 * Unrecognised grants are preserved on write and simply never match on read, so
 * round-tripping a role through an older device does not quietly strip permissions from it.
 */
export function isPermissionGrant(value: string): value is PermissionGrant {
  if (value === GRANT_ALL) return true;
  if (isPermissionKey(value)) return true;
  const [subject, action] = splitGrant(value);
  return action === '*' && subject in PERMISSION_SUBJECTS;
}

/** Split a grant into its subject and action halves. A malformed grant yields `['', '']`. */
export function splitGrant(value: string): readonly [subject: string, action: string] {
  const separator = value.indexOf(':');
  if (separator <= 0 || separator === value.length - 1) return ['', ''];
  return [value.slice(0, separator), value.slice(separator + 1)];
}

/** Every key belonging to one subject, in declaration order. */
export function permissionKeysFor(subject: PermissionSubject): readonly PermissionKey[] {
  return PERMISSION_SUBJECTS[subject].actions.map((action) => `${subject}:${action}` as PermissionKey);
}
