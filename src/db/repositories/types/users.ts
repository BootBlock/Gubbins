/**
 * User + role row/DTO types (issue #79, plan §2.1–§2.3).
 *
 * A user is a **principal** — someone actions are attributed to and permissions are resolved
 * for. This is deliberately not the same thing as a {@link Contact}, which is a person as
 * *data* (a loan borrower). The two stay separate tables: merging them would make every
 * borrower a potential sign-in.
 */
import type { UserKind } from '../constants';

export interface RoleRow {
  readonly id: string;
  readonly name: string;
  readonly description: string | null;
  /** JSON array of `"<subject>:<action>"` permission keys. Opaque to storage. */
  readonly permissions: string;
  readonly is_builtin: number;
  readonly created_at: number;
  readonly updated_at: number;
}

export interface Role {
  readonly id: string;
  readonly name: string;
  readonly description: string | null;
  /**
   * The permission keys this role grants, parsed from storage. The closed union that
   * validates them arrives with the permission engine in phase 2; until then this is
   * carried through verbatim so a role's grants survive a round-trip unchanged.
   */
  readonly permissions: readonly string[];
  /** A role shipped with Gubbins. Editable, but never deletable. */
  readonly isBuiltin: boolean;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface CreateRoleInput {
  readonly name: string;
  readonly description?: string | null;
  readonly permissions?: readonly string[];
}

export interface UpdateRoleInput {
  readonly name?: string;
  readonly description?: string | null;
  readonly permissions?: readonly string[];
}

export interface UserRow {
  readonly id: string;
  readonly username: string;
  readonly display_name: string;
  readonly email: string | null;
  readonly password_hash: string | null;
  readonly password_salt: string | null;
  readonly password_iterations: number | null;
  readonly is_enabled: number;
  readonly disabled_message: string | null;
  readonly kind: UserKind;
  readonly role_id: string | null;
  readonly created_at: number;
  readonly updated_at: number;
}

/**
 * A user as the application sees them.
 *
 * The password triple is deliberately **absent**: nothing outside the authentication seam
 * (phase 3) has any business reading a hash, and leaving it off the DTO means a careless
 * `JSON.stringify(user)` in a log, an export or a sync payload cannot leak it.
 */
export interface User {
  readonly id: string;
  readonly username: string;
  readonly displayName: string;
  readonly email: string | null;
  /**
   * Whether the user has a password at all. A user with none is a legitimate configuration
   * on a shared device where the point is attribution rather than secrecy (plan §1.1) — the
   * UI must say so plainly rather than implying a protection that isn't there.
   */
  readonly hasPassword: boolean;
  /** False disables sign-in. The built-in users cannot be disabled. */
  readonly isEnabled: boolean;
  /** Optional text shown on a blocked sign-in attempt. */
  readonly disabledMessage: string | null;
  readonly kind: UserKind;
  /** NULL for the built-in users, whose permissions are implicit and not editable. */
  readonly roleId: string | null;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface CreateUserInput {
  readonly username: string;
  readonly displayName?: string;
  readonly email?: string | null;
  readonly roleId?: string | null;
}

export interface UpdateUserInput {
  readonly username?: string;
  readonly displayName?: string;
  readonly email?: string | null;
  readonly isEnabled?: boolean;
  readonly disabledMessage?: string | null;
  readonly roleId?: string | null;
}
