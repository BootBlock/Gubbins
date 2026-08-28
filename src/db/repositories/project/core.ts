/**
 * ProjectRepository core (spec §2.1.1, §4 "Projects & BOMs", Phase 4).
 *
 * The projects-CRUD spine plus the shared `requireProject`/`requireLine` internals
 * every concern mixin builds on. All SQL lives over the injected driver (§2.1.1);
 * components never write SQL. Multi-row writes go through `driver.transaction` for
 * atomicity, and project deletion records a tombstone so it propagates on sync (§7.2).
 */
import { toStoredMoney } from '@/lib/money';
import { DbError } from '../../errors';
import type { SqlValue } from '../../rpc/driver';
import { BaseRepository } from '../base';
import { planCheckInAllForTarget } from '../checkout-plan';
import type { CostingMode } from '../constants';
import { escapeLike } from '../like';
import { rowToBomLine, rowToProject } from '../mappers';
import { tombstoneStatement } from '../tombstone';
import type {
  CreateProjectInput,
  Page,
  Project,
  ProjectBomLine,
  ProjectBomLineRow,
  ProjectFilter,
  ProjectListParams,
  ProjectRow,
  ProjectSort,
  ProjectWithCount,
  UpdateProjectInput,
} from '../types';

interface ProjectCountRow extends ProjectRow {
  readonly line_count: number;
}

/**
 * The `WHERE` clause (and its bound parameters) for a {@link ProjectFilter} — written once so
 * {@link ProjectCoreRepository.list} and {@link ProjectCoreRepository.count} can never disagree
 * about what matches, which would size the page strip for a different result set than the rows.
 *
 * `LIKE` is case-insensitive for ASCII in SQLite, which is what a name search wants, and the term
 * is escaped so a typed `%` or `_` matches itself rather than acting as a wildcard. The status is
 * bound as a parameter like any other value: an unrecognised one simply matches nothing.
 */
function projectFilter(filter: ProjectFilter): { where: string; params: SqlValue[] } {
  const clauses: string[] = [];
  const params: SqlValue[] = [];
  const term = filter.search?.trim() ?? '';
  if (term.length > 0) {
    clauses.push(`p.name LIKE ? ESCAPE '\\'`);
    params.push(`%${escapeLike(term)}%`);
  }
  if (filter.status) {
    clauses.push('p.status = ?');
    params.push(filter.status);
  }
  if (filter.statuses) {
    // An empty set matches nothing — `IN ()` is not valid SQLite, and silently ignoring the
    // filter would answer "every project" to a question that asked for none of them.
    if (filter.statuses.length === 0) {
      clauses.push('0');
    } else {
      clauses.push(`p.status IN (${filter.statuses.map(() => '?').join(', ')})`);
      params.push(...filter.statuses);
    }
  }
  return { where: clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '', params };
}

/**
 * The `ORDER BY` for each {@link ProjectSort}, allow-listed rather than composed from the
 * caller's string — the ordering is the one part of the query a filter can't parameterise, so it
 * is chosen from a fixed table and never interpolated from input.
 *
 * Every entry ends in `p.id ASC`, which makes the ordering **total**: two projects sharing a
 * creation instant and a name would otherwise sort in an unspecified order, and OFFSET paging
 * over a non-total order can repeat one row on page 2 while dropping another entirely (#149).
 */
const PROJECT_ORDER_BY: Record<ProjectSort, string> = {
  NEWEST: 'p.created_at DESC, p.name COLLATE NOCASE ASC, p.id ASC',
  OLDEST: 'p.created_at ASC, p.name COLLATE NOCASE ASC, p.id ASC',
  NAME_ASC: 'p.name COLLATE NOCASE ASC, p.created_at DESC, p.id ASC',
  NAME_DESC: 'p.name COLLATE NOCASE DESC, p.created_at DESC, p.id ASC',
};

/**
 * Coerce a budget input to a stored value: a non-negative finite number in integer micro-units
 * (the on-disk money scale, issue #286), or NULL to clear it. A negative or non-finite value
 * clears the budget rather than persisting a nonsensical figure (the §4 budget is optional, so
 * "no valid budget" is a clean state).
 */
function normaliseBudget(value: number | null | undefined): number | null {
  if (value == null || !Number.isFinite(value) || value < 0) return null;
  return toStoredMoney(value);
}

/**
 * Coerce an icon input to a stored value: a trimmed non-empty glyph name, or NULL to clear
 * it. Whitespace-only is treated as "no icon" so a blank never persists as a stored value.
 */
function normaliseIcon(value: string | null | undefined): string | null {
  if (value == null) return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export class ProjectCoreRepository extends BaseRepository {
  // --- projects ------------------------------------------------------------------

  async getById(id: string): Promise<Project | undefined> {
    const row = await this.driver.queryOne<ProjectRow>('SELECT * FROM projects WHERE id = ?;', [id]);
    return row ? rowToProject(row) : undefined;
  }

  /**
   * Paginated list of projects with their BOM-line counts, newest first by default.
   *
   * `search`, `status` and `sort` are all resolved **here** rather than by the caller filtering
   * a page it has already read (issue #137): a filter applied to one page of a paged list can
   * only ever narrow that page, so the project you were looking for stays exactly as unreachable
   * as it was. Pair it with {@link count} — given the same filter — to size the pages.
   */
  async list(params: ProjectListParams = {}): Promise<Page<ProjectWithCount>> {
    const { limit, offset } = this.resolvePage(params);
    const { where, params: filterParams } = projectFilter(params);
    const orderBy = PROJECT_ORDER_BY[params.sort ?? 'NEWEST'] ?? PROJECT_ORDER_BY.NEWEST;
    const rows = await this.driver.query<ProjectCountRow>(
      `SELECT p.*, COUNT(l.id) AS line_count
       FROM projects p
       LEFT JOIN project_bom_lines l ON l.project_id = p.id
       ${where}
       GROUP BY p.id
       ORDER BY ${orderBy}
       LIMIT ? OFFSET ?;`,
      [...filterParams, limit, offset],
    );
    return this.toPage(
      rows.map((r) => ({ ...rowToProject(r), lineCount: Number(r.line_count) })),
      limit,
      offset,
    );
  }

  /**
   * How many projects match the same filter {@link list} would apply — the denominator behind the
   * Projects master list's pagination (issue #149), and behind "how many of these did I just
   * narrow to" (issue #137). Projects accumulate as builds come and go, so the list pages
   * server-side rather than showing a capped read as if it were every project.
   */
  async count(filter: ProjectFilter = {}): Promise<number> {
    const { where, params } = projectFilter(filter);
    const row = await this.driver.queryOne<{ n: number }>(
      `SELECT COUNT(*) AS n FROM projects p ${where};`,
      params,
    );
    return Number(row?.n ?? 0);
  }

  async create(input: CreateProjectInput): Promise<Project> {
    this.assertPermission('projects:write');
    this.assertWritable();
    const name = input.name.trim();
    if (name.length === 0) {
      throw new DbError('SQLITE_CONSTRAINT', 'A project must have a name.');
    }
    const id = crypto.randomUUID();
    await this.driver.execute(
      'INSERT INTO projects (id, name, description, icon, costing_mode, budget) VALUES (?, ?, ?, ?, ?, ?);',
      [
        id,
        name,
        input.description ?? null,
        normaliseIcon(input.icon),
        input.costingMode ?? 'CURRENT_REPLACEMENT',
        normaliseBudget(input.budget),
      ],
    );
    return (await this.getById(id))!;
  }

  async update(id: string, input: UpdateProjectInput): Promise<Project> {
    this.assertPermission('projects:write');
    this.assertWritable();
    await this.requireProject(id);

    const sets: string[] = [];
    const params: SqlValue[] = [];
    if (input.name !== undefined) {
      const name = input.name.trim();
      if (name.length === 0) {
        throw new DbError('SQLITE_CONSTRAINT', 'A project must have a name.');
      }
      sets.push('name = ?');
      params.push(name);
    }
    if (input.description !== undefined) {
      sets.push('description = ?');
      params.push(input.description);
    }
    if (input.icon !== undefined) {
      sets.push('icon = ?');
      params.push(normaliseIcon(input.icon));
    }
    if (input.status !== undefined) {
      sets.push('status = ?');
      params.push(input.status);
    }
    if (input.costingMode !== undefined) {
      sets.push('costing_mode = ?');
      params.push(input.costingMode);
    }
    if (input.budget !== undefined) {
      sets.push('budget = ?');
      params.push(normaliseBudget(input.budget));
    }
    if (sets.length > 0) {
      params.push(id);
      await this.driver.execute(`UPDATE projects SET ${sets.join(', ')} WHERE id = ?;`, params);
    }
    return (await this.getById(id))!;
  }

  /** Set or clear (null) the project's overall budget (§4 budgeting). */
  async setBudget(id: string, budget: number | null): Promise<Project> {
    this.assertPermission('projects:write');
    return this.update(id, { budget });
  }

  /** Set just the BOM costing mode (spec §4 toggle). */
  async setCostingMode(id: string, mode: CostingMode): Promise<Project> {
    this.assertPermission('projects:write');
    return this.update(id, { costingMode: mode });
  }

  /**
   * Hard delete a project; its BOM lines cascade away. Allowed under Hard Stop.
   *
   * Every tool still out on the project is returned first (restoring stock and logging
   * `CHECKED_IN` as an ordinary check-in would, B4) so the delete never strands stock marked
   * "out". Those returns ride in **this** transaction (issue #301) rather than a preceding
   * awaited call, so a failed delete can't leave the loans force-returned against a project
   * that still exists.
   */
  async delete(id: string): Promise<void> {
    this.assertPermission('projects:delete');
    const returns = await planCheckInAllForTarget(this.driver, 'project', id, this.actorId());
    // Tombstone the deletion (Phase 11: projects is synced). BOM lines cascade locally
    // and, on a peer, from this same project tombstone, so they need none of their own.
    await this.driver.transaction([
      ...returns,
      { sql: 'DELETE FROM projects WHERE id = ?;', params: [id] },
      tombstoneStatement('projects', id),
    ]);
  }

  // --- shared internals ----------------------------------------------------------

  protected async requireProject(id: string): Promise<Project> {
    const project = await this.getById(id);
    if (!project) {
      throw new DbError('SQLITE_CONSTRAINT', `Project "${id}" does not exist.`);
    }
    return project;
  }

  protected async requireLine(id: string): Promise<{ line: ProjectBomLine }> {
    const row = await this.driver.queryOne<ProjectBomLineRow>(
      'SELECT * FROM project_bom_lines WHERE id = ?;',
      [id],
    );
    if (!row) {
      throw new DbError('SQLITE_CONSTRAINT', `BOM line "${id}" does not exist.`);
    }
    return { line: rowToBomLine(row) };
  }
}
