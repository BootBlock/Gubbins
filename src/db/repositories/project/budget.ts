/**
 * Budgeting concern (spec §4, on top of BOM Costing): an optional overall budget, named
 * sub-budget categories, and a manual expense ledger — plus the read-only roll-up the
 * project detail card and dashboard alerts consume.
 *
 * Spend has two lanes. The **committed** lane (`Σ received_qty × unit cost`) and the
 * **estimate** (full BOM) are *derived projections* over the BOM under the project's
 * costing mode — never stored counters, so they can never drift (the Phase-20 In-Transit
 * pattern). The **manual** lane is the `project_expenses` ledger: explicit recorded costs
 * the BOM cannot capture (shipping, labour, tools). `getBudget` gathers the raw aggregates;
 * the pure `summariseBudget` (features/projects/budget.ts) turns them into
 * spent/remaining/projected/status. Category/expense deletions are tombstoned for sync (§7.2).
 */
import { DbError } from '../../errors';
import type { SqlValue } from '../../rpc/driver';
import { normaliseText } from '../item/normalise';
import { rowToBudgetCategory, rowToExpense } from '../mappers';
import { tombstoneStatement } from '../tombstone';
import type {
  CreateBudgetCategoryInput,
  CreateExpenseInput,
  Page,
  PageParams,
  ProjectBudget,
  ProjectBudgetAlert,
  ProjectBudgetCategory,
  ProjectBudgetCategoryRollup,
  ProjectBudgetCategoryRow,
  ProjectExpense,
  ProjectExpenseRow,
  UpdateBudgetCategoryInput,
  UpdateExpenseInput,
} from '../types';
import type { Constructor } from './mixin';
import type { ProjectCoreRepository } from './core';

/** Validate a money amount: a non-negative finite number (the CHECK also enforces ≥ 0). */
function requireAmount(value: number): number {
  if (!Number.isFinite(value) || value < 0) {
    throw new DbError('SQLITE_CONSTRAINT', 'An amount must be a non-negative number.');
  }
  return value;
}

export function withBudget<TBase extends Constructor<ProjectCoreRepository>>(Base: TBase) {
  return class ProjectBudgetRepository extends Base {
    // --- budget roll-up ----------------------------------------------------------

    /**
     * Gather a project's raw budget aggregates: the allotted budget, the live/snapshot
     * full BOM estimate and the auto-derived committed BOM spend (both under the project's
     * costing mode), the manual expense total, and each category's allocation + spend. The
     * pure `summariseBudget` composes these into the spent/remaining/projected figures.
     */
    async getBudget(projectId: string): Promise<ProjectBudget> {
      const project = await this.requireProject(projectId);
      const costExpr = project.costingMode === 'POINT_IN_TIME' ? 'l.unit_cost_snapshot' : 'i.unit_cost';

      const bom = await this.driver.queryOne<{ estimated: number; committed: number }>(
        `SELECT
           COALESCE(SUM(CASE WHEN cost IS NOT NULL THEN required_qty * cost ELSE 0 END), 0) AS estimated,
           COALESCE(SUM(CASE WHEN cost IS NOT NULL THEN received_qty * cost ELSE 0 END), 0) AS committed
         FROM (
           SELECT l.required_qty AS required_qty, l.received_qty AS received_qty, ${costExpr} AS cost
           FROM project_bom_lines l
           LEFT JOIN items i ON i.id = l.item_id
           WHERE l.project_id = ?
         );`,
        [projectId],
      );

      const expenses = await this.driver.queryOne<{ total: number; uncategorised: number }>(
        `SELECT
           COALESCE(SUM(amount), 0) AS total,
           COALESCE(SUM(CASE WHEN category_id IS NULL THEN amount ELSE 0 END), 0) AS uncategorised
         FROM project_expenses WHERE project_id = ?;`,
        [projectId],
      );

      const categories = await this.categoryRollups(projectId);

      return {
        projectId,
        budget: project.budget,
        estimatedCost: Number(bom?.estimated ?? 0),
        committedFromBom: Number(bom?.committed ?? 0),
        manualExpenseTotal: Number(expenses?.total ?? 0),
        categories,
        uncategorisedExpenseTotal: Number(expenses?.uncategorised ?? 0),
      };
    }

    /**
     * Budget headlines for every project that has a budget set — the dashboard
     * "Budget alerts" feed. Each row carries the figures needed to derive a status without
     * re-fetching the project's full roll-up; cost uses each project's own costing mode.
     */
    async listBudgetAlerts(): Promise<ProjectBudgetAlert[]> {
      const rows = await this.driver.query<{
        project_id: string;
        project_name: string;
        budget: number;
        estimated: number;
        committed: number;
        manual: number;
      }>(
        `SELECT
           p.id AS project_id,
           p.name AS project_name,
           p.budget AS budget,
           COALESCE(SUM(CASE WHEN c.cost IS NOT NULL THEN c.required_qty * c.cost ELSE 0 END), 0) AS estimated,
           COALESCE(SUM(CASE WHEN c.cost IS NOT NULL THEN c.received_qty * c.cost ELSE 0 END), 0) AS committed,
           COALESCE((SELECT SUM(e.amount) FROM project_expenses e WHERE e.project_id = p.id), 0) AS manual
         FROM projects p
         LEFT JOIN (
           SELECT l.project_id AS project_id, l.required_qty AS required_qty, l.received_qty AS received_qty,
                  CASE WHEN pr.costing_mode = 'POINT_IN_TIME' THEN l.unit_cost_snapshot ELSE i.unit_cost END AS cost
           FROM project_bom_lines l
           JOIN projects pr ON pr.id = l.project_id
           LEFT JOIN items i ON i.id = l.item_id
         ) c ON c.project_id = p.id
         WHERE p.budget IS NOT NULL
         GROUP BY p.id
         ORDER BY p.name COLLATE NOCASE ASC;`,
      );

      return rows.map((r) => ({
        projectId: r.project_id,
        projectName: r.project_name,
        budget: Number(r.budget),
        estimatedCost: Number(r.estimated),
        committedFromBom: Number(r.committed),
        manualExpenseTotal: Number(r.manual),
      }));
    }

    // --- budget categories -------------------------------------------------------

    /** A project's budget categories joined with their recorded spend, in declared order. */
    private async categoryRollups(projectId: string): Promise<ProjectBudgetCategoryRollup[]> {
      const rows = await this.driver.query<{
        id: string;
        name: string;
        amount: number;
        position: number;
        spent: number;
      }>(
        `SELECT c.id AS id, c.name AS name, c.amount AS amount, c.position AS position,
                COALESCE((SELECT SUM(e.amount) FROM project_expenses e WHERE e.category_id = c.id), 0) AS spent
         FROM project_budget_categories c
         WHERE c.project_id = ?
         ORDER BY c.position ASC, c.created_at ASC;`,
        [projectId],
      );
      return rows.map((r) => ({
        id: r.id,
        name: r.name,
        amount: Number(r.amount),
        position: Number(r.position),
        spent: Number(r.spent),
      }));
    }

    async listBudgetCategories(projectId: string): Promise<ProjectBudgetCategory[]> {
      const rows = await this.driver.query<ProjectBudgetCategoryRow>(
        `SELECT * FROM project_budget_categories WHERE project_id = ?
         ORDER BY position ASC, created_at ASC;`,
        [projectId],
      );
      return rows.map(rowToBudgetCategory);
    }

    async addBudgetCategory(
      projectId: string,
      input: CreateBudgetCategoryInput,
    ): Promise<ProjectBudgetCategory> {
      this.assertWritable();
      await this.requireProject(projectId);
      const name = normaliseText(input.name);
      if (!name) {
        throw new DbError('SQLITE_CONSTRAINT', 'A budget category must have a name.');
      }
      const amount = requireAmount(input.amount ?? 0);
      const position = input.position ?? (await this.nextCategoryPosition(projectId));
      const id = crypto.randomUUID();
      await this.driver.execute(
        `INSERT INTO project_budget_categories (id, project_id, name, amount, position)
         VALUES (?, ?, ?, ?, ?);`,
        [id, projectId, name, amount, position],
      );
      return (await this.requireCategory(id)).category;
    }

    async updateBudgetCategory(
      categoryId: string,
      input: UpdateBudgetCategoryInput,
    ): Promise<ProjectBudgetCategory> {
      this.assertWritable();
      await this.requireCategory(categoryId);

      const sets: string[] = [];
      const params: SqlValue[] = [];
      if (input.name !== undefined) {
        const name = normaliseText(input.name);
        if (!name) {
          throw new DbError('SQLITE_CONSTRAINT', 'A budget category must have a name.');
        }
        sets.push('name = ?');
        params.push(name);
      }
      if (input.amount !== undefined) {
        sets.push('amount = ?');
        params.push(requireAmount(input.amount));
      }
      if (input.position !== undefined) {
        sets.push('position = ?');
        params.push(input.position);
      }
      if (sets.length > 0) {
        params.push(categoryId);
        await this.driver.execute(
          `UPDATE project_budget_categories SET ${sets.join(', ')} WHERE id = ?;`,
          params,
        );
      }
      return (await this.requireCategory(categoryId)).category;
    }

    /**
     * Remove a budget category. Its expenses are *un-categorised* (FK ON DELETE SET NULL),
     * not deleted — the spend is real and still counts toward the project total. Tombstoned
     * for sync (§7.2); on a peer the `category_id` FK_REFS guard clears dangling references.
     */
    async removeBudgetCategory(categoryId: string): Promise<void> {
      await this.driver.transaction([
        { sql: 'DELETE FROM project_budget_categories WHERE id = ?;', params: [categoryId] },
        tombstoneStatement('project_budget_categories', categoryId),
      ]);
    }

    // --- expenses ----------------------------------------------------------------

    /** Paginated expense ledger for a project, most-recently-incurred first. */
    async listExpenses(projectId: string, params: PageParams = {}): Promise<Page<ProjectExpense>> {
      const { limit, offset } = this.resolvePage(params);
      const rows = await this.driver.query<ProjectExpenseRow>(
        `SELECT * FROM project_expenses WHERE project_id = ?
         ORDER BY incurred_at DESC, created_at DESC
         LIMIT ? OFFSET ?;`,
        [projectId, limit, offset],
      );
      return this.toPage(rows.map(rowToExpense), limit, offset);
    }

    async addExpense(projectId: string, input: CreateExpenseInput): Promise<ProjectExpense> {
      this.assertWritable();
      await this.requireProject(projectId);
      const amount = requireAmount(input.amount);
      const categoryId = await this.resolveCategoryRef(projectId, input.categoryId);
      const id = crypto.randomUUID();
      const sets = ['id', 'project_id', 'category_id', 'description', 'amount'];
      const values: SqlValue[] = [id, projectId, categoryId, normaliseText(input.description), amount];
      if (input.incurredAt !== undefined) {
        sets.push('incurred_at');
        values.push(input.incurredAt);
      }
      await this.driver.execute(
        `INSERT INTO project_expenses (${sets.join(', ')}) VALUES (${sets.map(() => '?').join(', ')});`,
        values,
      );
      return (await this.requireExpense(id)).expense;
    }

    async updateExpense(expenseId: string, input: UpdateExpenseInput): Promise<ProjectExpense> {
      this.assertWritable();
      const { expense } = await this.requireExpense(expenseId);

      const sets: string[] = [];
      const params: SqlValue[] = [];
      if (input.description !== undefined) {
        sets.push('description = ?');
        params.push(normaliseText(input.description));
      }
      if (input.amount !== undefined) {
        sets.push('amount = ?');
        params.push(requireAmount(input.amount));
      }
      if (input.categoryId !== undefined) {
        sets.push('category_id = ?');
        params.push(await this.resolveCategoryRef(expense.projectId, input.categoryId));
      }
      if (input.incurredAt !== undefined) {
        sets.push('incurred_at = ?');
        params.push(input.incurredAt);
      }
      if (sets.length > 0) {
        params.push(expenseId);
        await this.driver.execute(`UPDATE project_expenses SET ${sets.join(', ')} WHERE id = ?;`, params);
      }
      return (await this.requireExpense(expenseId)).expense;
    }

    /** Remove an expense. Tombstoned for sync (§7.2). */
    async removeExpense(expenseId: string): Promise<void> {
      await this.driver.transaction([
        { sql: 'DELETE FROM project_expenses WHERE id = ?;', params: [expenseId] },
        tombstoneStatement('project_expenses', expenseId),
      ]);
    }

    // --- shared internals --------------------------------------------------------

    /** Validate that a category id (if given) belongs to this project; null clears it. */
    private async resolveCategoryRef(
      projectId: string,
      categoryId: string | null | undefined,
    ): Promise<string | null> {
      if (!categoryId) return null;
      const row = await this.driver.queryOne<{ project_id: string }>(
        'SELECT project_id FROM project_budget_categories WHERE id = ?;',
        [categoryId],
      );
      if (!row || row.project_id !== projectId) {
        throw new DbError(
          'SQLITE_CONSTRAINT_FOREIGNKEY',
          `Budget category "${categoryId}" does not belong to this project.`,
        );
      }
      return categoryId;
    }

    private async nextCategoryPosition(projectId: string): Promise<number> {
      const row = await this.driver.queryOne<{ next: number }>(
        'SELECT COALESCE(MAX(position), -1) + 1 AS next FROM project_budget_categories WHERE project_id = ?;',
        [projectId],
      );
      return Number(row?.next ?? 0);
    }

    private async requireCategory(id: string): Promise<{ category: ProjectBudgetCategory }> {
      const row = await this.driver.queryOne<ProjectBudgetCategoryRow>(
        'SELECT * FROM project_budget_categories WHERE id = ?;',
        [id],
      );
      if (!row) {
        throw new DbError('SQLITE_CONSTRAINT', `Budget category "${id}" does not exist.`);
      }
      return { category: rowToBudgetCategory(row) };
    }

    private async requireExpense(id: string): Promise<{ expense: ProjectExpense }> {
      const row = await this.driver.queryOne<ProjectExpenseRow>(
        'SELECT * FROM project_expenses WHERE id = ?;',
        [id],
      );
      if (!row) {
        throw new DbError('SQLITE_CONSTRAINT', `Expense "${id}" does not exist.`);
      }
      return { expense: rowToExpense(row) };
    }
  };
}
