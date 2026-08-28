/**
 * RoleRepository (issue #79, plan §2.3).
 *
 * A role is a named bundle of permission keys that users are assigned to. Permissions
 * themselves are stored opaquely as a JSON array here: the closed union that validates a key
 * arrives with the permission engine in phase 2, and keeping storage agnostic means the
 * registry can grow without a schema change.
 *
 * Grants are canonicalised through `normaliseGrants` on the way in — trimmed, de-duplicated
 * and ordered — so a role written here is stored in exactly the shape the baseline seeds the
 * built-in ones with, and a padded `" items:write "` can never persist as a grant that
 * silently matches nothing. Grants this build does not recognise are deliberately *kept*: a
 * newer peer may hold a key this one has never heard of, and editing the role here must not
 * strip it.
 *
 * Built-in roles are **editable but not deletable** (plan §2.3) — an operator may retune what
 * "Stocker" grants, but removing it outright would strand every user assigned to it. As with
 * users, that guard is enforced here *and* by `trg_roles_protect_builtin_delete`.
 *
 * `roles` participates in synchronisation, so a hard delete records a tombstone in the same
 * transaction (§7.2).
 */
import { normaliseGrants } from '@/features/users/permissions';
import { TEXT_LIMITS } from '@/lib/text-limits';
import { assertTextLimit } from './text-limits';
import { normaliseText } from './item/normalise';
import { DbError } from '../errors';
import { BaseRepository } from './base';
import { rowToRole } from './mappers';
import { duplicateNameError, foldedNameFilter, matchesFoldedName } from './name-lookup';
import { tombstoneStatement } from './tombstone';
import type { CreateRoleInput, Page, PageParams, Role, RoleRow, UpdateRoleInput } from './types';

export class RoleRepository extends BaseRepository {
  async getById(id: string): Promise<Role | undefined> {
    const row = await this.driver.queryOne<RoleRow>('SELECT * FROM roles WHERE id = ?;', [id]);
    return row ? rowToRole(row) : undefined;
  }

  /**
   * Look a role up by name (case-insensitive), or `undefined`.
   *
   * Matched in JS rather than by the collation (issue #679) — `idx_roles_name` folds ASCII A–Z
   * only, so `WHERE name = ? COLLATE NOCASE` would answer "free" for a name that differs from a
   * stored one by an accent's case alone. See `name-lookup`.
   */
  async findByName(name: string): Promise<Role | undefined> {
    const trimmed = name.trim();
    if (trimmed.length === 0) return undefined;
    const filter = foldedNameFilter('name', [trimmed]);
    const rows = await this.driver.query<RoleRow>(
      `SELECT * FROM roles WHERE ${filter.sql} ORDER BY name, id;`,
      filter.params,
    );
    const row = rows.find((r) => matchesFoldedName(filter, r.name));
    return row ? rowToRole(row) : undefined;
  }

  /** Paginated roles, built-ins first then by name. */
  async list(params: PageParams = {}): Promise<Page<Role>> {
    const { limit, offset } = this.resolvePage(params);
    const rows = await this.driver.query<RoleRow>(
      `SELECT * FROM roles
       ORDER BY is_builtin DESC, name COLLATE NOCASE ASC
       LIMIT ? OFFSET ?;`,
      [limit, offset],
    );
    return this.toPage(rows.map(rowToRole), limit, offset);
  }

  /** Create an operator-defined role. `is_builtin` is not an input — only the baseline seeds those. */
  async create(input: CreateRoleInput): Promise<Role> {
    this.assertPermission('users:manage');
    this.assertWritable();
    const name = input.name.trim();
    if (name.length === 0) {
      throw new DbError('SQLITE_CONSTRAINT', 'A role must have a name.');
    }
    assertTextLimit(name, TEXT_LIMITS.line, 'A role name');
    // The index only refuses a duplicate it can fold (issue #679); this is the other half.
    if (await this.findByName(name)) throw duplicateNameError('roles.name');
    const id = crypto.randomUUID();
    await this.driver.execute(
      `INSERT INTO roles (id, name, description, icon, permissions, is_builtin)
       VALUES (?, ?, ?, ?, ?, 0);`,
      [
        id,
        name,
        input.description?.trim() || null,
        normaliseText(input.icon, TEXT_LIMITS.code, 'A role icon'),
        JSON.stringify(normaliseGrants(input.permissions ?? [])),
      ],
    );
    return (await this.getById(id))!;
  }

  async update(id: string, input: UpdateRoleInput): Promise<Role> {
    this.assertPermission('users:manage');
    this.assertWritable();
    await this.require(id);
    const sets: string[] = [];
    const params: (string | null)[] = [];
    if (input.name !== undefined) {
      const name = input.name.trim();
      if (name.length === 0) {
        throw new DbError('SQLITE_CONSTRAINT', 'A role must have a name.');
      }
      assertTextLimit(name, TEXT_LIMITS.line, 'A role name');
      const holder = await this.findByName(name);
      if (holder && holder.id !== id) throw duplicateNameError('roles.name');
      sets.push('name = ?');
      params.push(name);
    }
    if (input.description !== undefined) {
      sets.push('description = ?');
      params.push(input.description?.trim() || null);
    }
    if (input.icon !== undefined) {
      sets.push('icon = ?');
      params.push(normaliseText(input.icon, TEXT_LIMITS.code, 'A role icon'));
    }
    if (input.permissions !== undefined) {
      sets.push('permissions = ?');
      params.push(JSON.stringify(normaliseGrants(input.permissions)));
    }
    if (sets.length > 0) {
      await this.driver.execute(`UPDATE roles SET ${sets.join(', ')} WHERE id = ?;`, [...params, id]);
    }
    return (await this.getById(id))!;
  }

  /**
   * Delete a role. Users assigned to it keep their accounts and lose only the grant — the
   * column's `ON DELETE SET NULL` clears `users.role_id` — so removing a role can never
   * delete a person. Bypasses the Hard Stop; records a tombstone so the deletion syncs (§7.2).
   */
  async delete(id: string): Promise<void> {
    this.assertPermission('users:manage');
    const existing = await this.require(id);
    if (existing.isBuiltin) {
      throw new DbError(
        'SQLITE_CONSTRAINT',
        `The built-in "${existing.name}" role cannot be deleted. Edit its permissions instead.`,
      );
    }
    await this.driver.transaction([
      { sql: 'DELETE FROM roles WHERE id = ?;', params: [id] },
      tombstoneStatement('roles', id),
    ]);
  }

  private async require(id: string): Promise<Role> {
    const role = await this.getById(id);
    if (!role) {
      throw new DbError('SQLITE_CONSTRAINT', `Role "${id}" does not exist.`);
    }
    return role;
  }
}
