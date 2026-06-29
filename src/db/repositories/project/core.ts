/**
 * ProjectRepository core (spec §2.1.1, §4 "Projects & BOMs", Phase 4).
 *
 * The projects-CRUD spine plus the shared `requireProject`/`requireLine` internals
 * every concern mixin builds on. All SQL lives over the injected driver (§2.1.1);
 * components never write SQL. Multi-row writes go through `driver.transaction` for
 * atomicity, and project deletion records a tombstone so it propagates on sync (§7.2).
 */
import { DbError } from '../../errors';
import type { SqlValue } from '../../rpc/driver';
import { BaseRepository } from '../base';
import type { CostingMode } from '../constants';
import { rowToBomLine, rowToProject } from '../mappers';
import { tombstoneStatement } from '../tombstone';
import type {
  CreateProjectInput,
  Page,
  PageParams,
  Project,
  ProjectBomLine,
  ProjectBomLineRow,
  ProjectRow,
  ProjectWithCount,
  UpdateProjectInput,
} from '../types';

interface ProjectCountRow extends ProjectRow {
  readonly line_count: number;
}

export class ProjectCoreRepository extends BaseRepository {
  // --- projects ------------------------------------------------------------------

  async getById(id: string): Promise<Project | undefined> {
    const row = await this.driver.queryOne<ProjectRow>('SELECT * FROM projects WHERE id = ?;', [id]);
    return row ? rowToProject(row) : undefined;
  }

  /** Paginated list of projects with their BOM-line counts, newest first. */
  async list(params: PageParams = {}): Promise<Page<ProjectWithCount>> {
    const { limit, offset } = this.resolvePage(params);
    const rows = await this.driver.query<ProjectCountRow>(
      `SELECT p.*, COUNT(l.id) AS line_count
       FROM projects p
       LEFT JOIN project_bom_lines l ON l.project_id = p.id
       GROUP BY p.id
       ORDER BY p.created_at DESC, p.name COLLATE NOCASE ASC
       LIMIT ? OFFSET ?;`,
      [limit, offset],
    );
    return this.toPage(
      rows.map((r) => ({ ...rowToProject(r), lineCount: Number(r.line_count) })),
      limit,
      offset,
    );
  }

  async create(input: CreateProjectInput): Promise<Project> {
    this.assertWritable();
    const name = input.name.trim();
    if (name.length === 0) {
      throw new DbError('SQLITE_CONSTRAINT', 'A project must have a name.');
    }
    const id = crypto.randomUUID();
    await this.driver.execute(
      'INSERT INTO projects (id, name, description, costing_mode) VALUES (?, ?, ?, ?);',
      [id, name, input.description ?? null, input.costingMode ?? 'CURRENT_REPLACEMENT'],
    );
    return (await this.getById(id))!;
  }

  async update(id: string, input: UpdateProjectInput): Promise<Project> {
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
    if (input.status !== undefined) {
      sets.push('status = ?');
      params.push(input.status);
    }
    if (input.costingMode !== undefined) {
      sets.push('costing_mode = ?');
      params.push(input.costingMode);
    }
    if (sets.length > 0) {
      params.push(id);
      await this.driver.execute(`UPDATE projects SET ${sets.join(', ')} WHERE id = ?;`, params);
    }
    return (await this.getById(id))!;
  }

  /** Set just the BOM costing mode (spec §4 toggle). */
  async setCostingMode(id: string, mode: CostingMode): Promise<Project> {
    return this.update(id, { costingMode: mode });
  }

  /** Hard delete a project; its BOM lines cascade away. Allowed under Hard Stop. */
  async delete(id: string): Promise<void> {
    // Tombstone the deletion (Phase 11: projects is synced). BOM lines cascade locally
    // and, on a peer, from this same project tombstone, so they need none of their own.
    await this.driver.transaction([
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
