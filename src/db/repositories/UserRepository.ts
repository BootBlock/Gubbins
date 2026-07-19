/**
 * UserRepository (issue #79, plan §2.1–§2.2).
 *
 * The principals actions are attributed to and permissions are resolved for. Two rows are
 * seeded by the baseline and are immovable: **System** (the actor for anything the app itself
 * does) and **Admin** (full access, and the identity single-user mode transparently acts as).
 *
 * The built-in guards here are deliberately *duplicated* by `trg_users_protect_builtin_*` in
 * the schema. That is not redundancy: this layer produces a legible {@link DbError} for the
 * UI, while the trigger is what actually holds if a write ever reaches SQLite by another
 * route — an import, a restore, a future Bridge write, or a bug. A guard that exists only in
 * application code is not a guard.
 *
 * `users` participates in synchronisation, so a hard delete records a tombstone in the same
 * transaction (§7.2). The built-in rows are excluded from the sync snapshot entirely — every
 * device seeds them identically from the baseline.
 */
import { hashPassword, needsRehash, verifyPassword } from '@/features/users/password';
import { DbError } from '../errors';
import { BaseRepository } from './base';
import { BUILTIN_USER_IDS } from './constants';
import { rowToUser } from './mappers';
import { tombstoneStatement } from './tombstone';
import type { CreateUserInput, Page, PageParams, UpdateUserInput, User, UserRow } from './types';

/**
 * The result of a sign-in attempt. A failure names its cause so the screen can say something
 * true — "that password is wrong" and "this account has been disabled" call for different
 * copy, and the second may carry a message the administrator wrote.
 */
export type SignInOutcome =
  | { readonly ok: true; readonly user: User }
  | { readonly ok: false; readonly reason: 'unknown-user' | 'wrong-password' }
  | { readonly ok: false; readonly reason: 'disabled'; readonly disabledMessage: string | null };

export class UserRepository extends BaseRepository {
  async getById(id: string): Promise<User | undefined> {
    const row = await this.driver.queryOne<UserRow>('SELECT * FROM users WHERE id = ?;', [id]);
    return row ? rowToUser(row) : undefined;
  }

  /** Look a user up by sign-in handle (case-insensitive), or `undefined`. */
  async findByUsername(username: string): Promise<User | undefined> {
    const trimmed = username.trim();
    if (trimmed.length === 0) return undefined;
    const row = await this.driver.queryOne<UserRow>(
      'SELECT * FROM users WHERE username = ? COLLATE NOCASE;',
      [trimmed],
    );
    return row ? rowToUser(row) : undefined;
  }

  /**
   * Paginated users, built-ins first then by display name — so System and Admin keep a stable
   * position at the top of an admin list rather than sorting in among ordinary accounts.
   */
  async list(params: PageParams = {}): Promise<Page<User>> {
    const { limit, offset } = this.resolvePage(params);
    const rows = await this.driver.query<UserRow>(
      `SELECT * FROM users
       ORDER BY CASE kind WHEN 'system' THEN 0 WHEN 'admin' THEN 1 ELSE 2 END ASC,
                display_name COLLATE NOCASE ASC
       LIMIT ? OFFSET ?;`,
      [limit, offset],
    );
    return this.toPage(rows.map(rowToUser), limit, offset);
  }

  /**
   * Create an ordinary user. `kind` is not an input: only the baseline may mint a
   * system/admin principal, so there is no path by which application code can create a
   * second unrestricted account.
   *
   * The new user has **no password** — setting one is the authentication seam's job
   * (phase 3), and a user without one is a legitimate end state (plan §1.1).
   */
  async create(input: CreateUserInput): Promise<User> {
    this.assertPermission('users:manage');
    this.assertWritable();
    const username = input.username.trim();
    if (username.length === 0) {
      throw new DbError('SQLITE_CONSTRAINT', 'A user must have a username.');
    }
    const displayName = input.displayName?.trim() || username;
    const id = crypto.randomUUID();
    await this.driver.execute(
      `INSERT INTO users (id, username, display_name, email, kind, role_id)
       VALUES (?, ?, ?, ?, 'normal', ?);`,
      [id, username, displayName, input.email?.trim() || null, input.roleId ?? null],
    );
    return (await this.getById(id))!;
  }

  async update(id: string, input: UpdateUserInput): Promise<User> {
    this.assertPermission('users:manage');
    this.assertWritable();
    const existing = await this.require(id);
    this.assertNotBuiltin(existing, 'modified');

    const sets: string[] = [];
    const params: (string | number | null)[] = [];
    if (input.username !== undefined) {
      const username = input.username.trim();
      if (username.length === 0) {
        throw new DbError('SQLITE_CONSTRAINT', 'A user must have a username.');
      }
      sets.push('username = ?');
      params.push(username);
    }
    if (input.displayName !== undefined) {
      const displayName = input.displayName.trim();
      if (displayName.length === 0) {
        throw new DbError('SQLITE_CONSTRAINT', 'A user must have a display name.');
      }
      sets.push('display_name = ?');
      params.push(displayName);
    }
    if (input.email !== undefined) {
      sets.push('email = ?');
      params.push(input.email?.trim() || null);
    }
    if (input.isEnabled !== undefined) {
      sets.push('is_enabled = ?');
      params.push(input.isEnabled ? 1 : 0);
    }
    if (input.disabledMessage !== undefined) {
      sets.push('disabled_message = ?');
      params.push(input.disabledMessage?.trim() || null);
    }
    if (input.roleId !== undefined) {
      sets.push('role_id = ?');
      params.push(input.roleId);
    }
    if (sets.length > 0) {
      await this.driver.execute(`UPDATE users SET ${sets.join(', ')} WHERE id = ?;`, [...params, id]);
    }
    return (await this.getById(id))!;
  }

  /**
   * Delete a user. Their Activity-Ledger entries are **not** deleted: the column's
   * `ON DELETE SET DEFAULT` re-attributes them to System, so removing an account never
   * destroys the record of what was done (plan §2.4). Bypasses the Hard Stop, as deletes free
   * space. Records a tombstone in the same transaction so the deletion syncs (§7.2).
   */
  async delete(id: string): Promise<void> {
    this.assertPermission('users:manage');
    const existing = await this.require(id);
    this.assertNotBuiltin(existing, 'deleted');
    await this.driver.transaction([
      { sql: 'DELETE FROM users WHERE id = ?;', params: [id] },
      tombstoneStatement('users', id),
    ]);
  }

  /**
   * Set (or replace) a user's password (issue #79, plan §1.1).
   *
   * Permitted on the built-in **Admin**, unlike every other edit: with the users module on,
   * Admin is a real account someone signs in as, and a full-access account that could not be
   * given a password would be worse than no sign-in at all. `trg_users_protect_admin_update`
   * allows exactly this and still refuses a rename, a re-role or a disable. **System** remains
   * fully immutable — it never signs in.
   *
   * The plaintext never leaves this method: it is hashed here and only the triple is written.
   */
  async setPassword(id: string, password: string): Promise<User> {
    this.assertPermission('users:manage');
    this.assertWritable();
    const existing = await this.require(id);
    this.assertPasswordSettable(existing);

    const credential = await hashPassword(password);
    await this.driver.execute(
      `UPDATE users SET password_hash = ?, password_salt = ?, password_iterations = ? WHERE id = ?;`,
      [credential.hash, credential.salt, credential.iterations, id],
    );
    return (await this.getById(id))!;
  }

  /**
   * Remove a user's password, leaving them able to sign in without one.
   *
   * A legitimate end state on a shared device where the point is attribution rather than
   * secrecy (plan §1.1) — the UI is required to say so plainly wherever it appears. Clears all
   * three columns together, which is what the row's all-or-nothing CHECK demands.
   */
  async clearPassword(id: string): Promise<User> {
    this.assertPermission('users:manage');
    const existing = await this.require(id);
    this.assertPasswordSettable(existing);

    await this.driver.execute(
      `UPDATE users SET password_hash = NULL, password_salt = NULL, password_iterations = NULL WHERE id = ?;`,
      [id],
    );
    return (await this.getById(id))!;
  }

  /**
   * Verify a sign-in attempt, and report *why* it failed rather than just that it did.
   *
   * Deliberately **not** permission-gated: the caller is signing in, so by definition holds no
   * authority yet. This is the one write-adjacent path that must work for an anonymous caller.
   *
   * The hash never leaves the repository — it is read, compared here, and discarded, which is
   * why the `User` DTO has no field for it. On success at a stale iteration count the password
   * is transparently re-hashed at the current one; that is the only moment the plaintext is in
   * hand, so it is the only moment the upgrade is possible.
   */
  async verifySignIn(id: string, password: string): Promise<SignInOutcome> {
    const row = await this.driver.queryOne<UserRow>('SELECT * FROM users WHERE id = ?;', [id]);
    if (!row) return { ok: false, reason: 'unknown-user' };
    // System is an actor, not a person: it has no password and must never be signed in as.
    if (row.kind === 'system') return { ok: false, reason: 'unknown-user' };
    if (row.is_enabled !== 1) {
      return { ok: false, reason: 'disabled', disabledMessage: row.disabled_message };
    }

    if (row.password_hash === null || row.password_salt === null || row.password_iterations === null) {
      // No password set: signing in is allowed, and the UI is responsible for saying plainly
      // that this account is unprotected.
      return { ok: true, user: rowToUser(row) };
    }

    const credential = {
      hash: row.password_hash,
      salt: row.password_salt,
      iterations: row.password_iterations,
    };
    if (!(await verifyPassword(password, credential))) return { ok: false, reason: 'wrong-password' };

    if (needsRehash(credential)) {
      const upgraded = await hashPassword(password);
      await this.driver.execute(
        `UPDATE users SET password_hash = ?, password_salt = ?, password_iterations = ? WHERE id = ?;`,
        [upgraded.hash, upgraded.salt, upgraded.iterations, id],
      );
    }
    return { ok: true, user: rowToUser(row) };
  }

  /**
   * The accounts the sign-in screen offers, in the order it shows them.
   *
   * **System is excluded** — it is the actor the app writes as, not a person, and has no
   * password to check. Disabled users are deliberately *included*: the issue asks that a
   * disabled user be told they cannot sign in, optionally with a message explaining why, and
   * a tile that is present but refused says that far better than a silently missing one.
   */
  async listSignInCandidates(): Promise<readonly User[]> {
    const rows = await this.driver.query<UserRow>(
      `SELECT * FROM users
       WHERE kind <> 'system'
       ORDER BY CASE kind WHEN 'admin' THEN 0 ELSE 1 END ASC,
                display_name COLLATE NOCASE ASC;`,
    );
    return rows.map(rowToUser);
  }

  /** Refuse a password change on System; Admin is allowed (see {@link setPassword}). */
  private assertPasswordSettable(user: User): void {
    if (user.kind === 'system') {
      throw new DbError(
        'SQLITE_CONSTRAINT',
        'The built-in System user is an actor rather than a person, so it cannot have a password.',
      );
    }
  }

  private assertNotBuiltin(user: User, verb: 'modified' | 'deleted'): void {
    if (BUILTIN_USER_IDS.includes(user.id as (typeof BUILTIN_USER_IDS)[number])) {
      throw new DbError('SQLITE_CONSTRAINT', `The built-in ${user.displayName} user cannot be ${verb}.`);
    }
  }

  private async require(id: string): Promise<User> {
    const user = await this.getById(id);
    if (!user) {
      throw new DbError('SQLITE_CONSTRAINT', `User "${id}" does not exist.`);
    }
    return user;
  }
}
