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
import { DbError } from '../errors';
import { BaseRepository } from './base';
import { BUILTIN_USER_IDS } from './constants';
import { rowToUser } from './mappers';
import { tombstoneStatement } from './tombstone';
import type { CreateUserInput, Page, PageParams, UpdateUserInput, User, UserRow } from './types';

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
