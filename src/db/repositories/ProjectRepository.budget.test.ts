import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createMemoryDriver, type MemoryDriver } from '@/test/drivers/memory-driver';
import { runMigrations } from '@/db/migrations/engine';
import { migrations } from '@/db/migrations';
import { DbError } from '@/db/errors';
import { ItemRepository } from './ItemRepository';
import { ProjectRepository } from './ProjectRepository';

describe('ProjectRepository budgeting (spec §4)', () => {
  let driver: MemoryDriver;
  let projects: ProjectRepository;
  let items: ItemRepository;

  beforeEach(async () => {
    driver = createMemoryDriver();
    await runMigrations(driver, migrations);
    projects = new ProjectRepository(driver);
    items = new ItemRepository(driver);
  });

  afterEach(async () => {
    await driver.close();
  });

  // --- the budget column ---------------------------------------------------------

  it('creates a project with no budget by default', async () => {
    const p = await projects.create({ name: 'Amp' });
    expect(p.budget).toBeNull();
  });

  it('sets, reads back and clears the overall budget', async () => {
    const p = await projects.create({ name: 'Amp', budget: 500 });
    expect(p.budget).toBe(500);

    const cleared = await projects.setBudget(p.id, null);
    expect(cleared.budget).toBeNull();

    const reset = await projects.setBudget(p.id, 750);
    expect(reset.budget).toBe(750);
  });

  it('normalises a negative or non-finite budget to null', async () => {
    const p = await projects.create({ name: 'Amp', budget: -10 });
    expect(p.budget).toBeNull();
    const updated = await projects.update(p.id, { budget: Number.NaN });
    expect(updated.budget).toBeNull();
  });

  // --- getBudget roll-up ---------------------------------------------------------

  it('derives estimated and committed BOM spend under the costing mode', async () => {
    const ic = await items.create({ name: 'IC', unitCost: 2, quantity: 100 });
    const p = await projects.create({ name: 'Build', budget: 100 });
    const line = await projects.addLine(p.id, { itemId: ic.id, requiredQty: 10 }); // estimate 20

    // Nothing received yet → committed 0, estimate 20.
    let budget = await projects.getBudget(p.id);
    expect(budget.estimatedCost).toBe(20);
    expect(budget.committedFromBom).toBe(0);

    // Receive 4 → committed 8 (4 × 2), estimate unchanged.
    await projects.receiveLine(line.id, { quantity: 4 });
    budget = await projects.getBudget(p.id);
    expect(budget.estimatedCost).toBe(20);
    expect(budget.committedFromBom).toBe(8);
    expect(budget.budget).toBe(100);
  });

  it('sums the manual expense ledger and splits out the uncategorised portion', async () => {
    const p = await projects.create({ name: 'Build', budget: 500 });
    const cat = await projects.addBudgetCategory(p.id, { name: 'Shipping', amount: 50 });
    await projects.addExpense(p.id, { description: 'Courier', amount: 12, categoryId: cat.id });
    await projects.addExpense(p.id, { description: 'Misc', amount: 8 }); // uncategorised

    const budget = await projects.getBudget(p.id);
    expect(budget.manualExpenseTotal).toBe(20);
    expect(budget.uncategorisedExpenseTotal).toBe(8);
    expect(budget.categories).toHaveLength(1);
    expect(budget.categories[0]).toMatchObject({ name: 'Shipping', amount: 50, spent: 12 });
  });

  // --- categories ----------------------------------------------------------------

  it('creates, lists, updates and removes budget categories in order', async () => {
    const p = await projects.create({ name: 'Build' });
    const parts = await projects.addBudgetCategory(p.id, { name: 'Parts', amount: 300 });
    await projects.addBudgetCategory(p.id, { name: 'Labour', amount: 100 });

    const list = await projects.listBudgetCategories(p.id);
    expect(list.map((c) => c.name)).toEqual(['Parts', 'Labour']);
    expect(list[0].position).toBe(0);
    expect(list[1].position).toBe(1);

    await projects.updateBudgetCategory(parts.id, { amount: 350 });
    const reread = await projects.listBudgetCategories(p.id);
    expect(reread.find((c) => c.id === parts.id)?.amount).toBe(350);

    await projects.removeBudgetCategory(parts.id);
    expect((await projects.listBudgetCategories(p.id)).map((c) => c.name)).toEqual(['Labour']);
  });

  it('rejects a blank category name and a negative amount', async () => {
    const p = await projects.create({ name: 'Build' });
    await expect(projects.addBudgetCategory(p.id, { name: '  ' })).rejects.toBeInstanceOf(DbError);
    await expect(projects.addBudgetCategory(p.id, { name: 'Bad', amount: -1 })).rejects.toBeInstanceOf(
      DbError,
    );
  });

  it('un-categorises (keeps) expenses when their category is removed', async () => {
    const p = await projects.create({ name: 'Build' });
    const cat = await projects.addBudgetCategory(p.id, { name: 'Shipping', amount: 50 });
    await projects.addExpense(p.id, { description: 'Courier', amount: 12, categoryId: cat.id });

    await projects.removeBudgetCategory(cat.id);

    const budget = await projects.getBudget(p.id);
    // The spend survives and is now uncategorised.
    expect(budget.manualExpenseTotal).toBe(12);
    expect(budget.uncategorisedExpenseTotal).toBe(12);
    const ledger = await projects.listExpenses(p.id);
    expect(ledger.rows[0].categoryId).toBeNull();
  });

  // --- expenses ------------------------------------------------------------------

  it('adds, lists (newest first), updates and removes expenses', async () => {
    const p = await projects.create({ name: 'Build' });
    await projects.addExpense(p.id, { description: 'Old', amount: 5, incurredAt: 1000 });
    const recent = await projects.addExpense(p.id, { description: 'New', amount: 7, incurredAt: 2000 });

    const ledger = await projects.listExpenses(p.id);
    expect(ledger.rows.map((e) => e.description)).toEqual(['New', 'Old']);

    await projects.updateExpense(recent.id, { amount: 9, description: 'New (fixed)' });
    const reread = await projects.listExpenses(p.id);
    expect(reread.rows.find((e) => e.id === recent.id)).toMatchObject({
      amount: 9,
      description: 'New (fixed)',
    });

    await projects.removeExpense(recent.id);
    expect((await projects.listExpenses(p.id)).rows.map((e) => e.description)).toEqual(['Old']);
  });

  it('rejects a negative expense amount', async () => {
    const p = await projects.create({ name: 'Build' });
    await expect(projects.addExpense(p.id, { amount: -3 })).rejects.toBeInstanceOf(DbError);
  });

  it('rejects assigning an expense to another project’s category', async () => {
    const p1 = await projects.create({ name: 'One' });
    const p2 = await projects.create({ name: 'Two' });
    const foreign = await projects.addBudgetCategory(p2.id, { name: 'Parts', amount: 10 });
    await expect(projects.addExpense(p1.id, { amount: 5, categoryId: foreign.id })).rejects.toBeInstanceOf(
      DbError,
    );
  });

  it('cascades categories and expenses when the project is deleted', async () => {
    const p = await projects.create({ name: 'Build' });
    const cat = await projects.addBudgetCategory(p.id, { name: 'Parts', amount: 10 });
    await projects.addExpense(p.id, { amount: 5, categoryId: cat.id });

    await projects.delete(p.id);

    const cats = await driver.query('SELECT id FROM project_budget_categories WHERE project_id = ?;', [p.id]);
    const exps = await driver.query('SELECT id FROM project_expenses WHERE project_id = ?;', [p.id]);
    expect(cats).toHaveLength(0);
    expect(exps).toHaveLength(0);
  });

  // --- dashboard feed ------------------------------------------------------------

  it('lists only budgeted projects in the budget-alerts feed with derived spend', async () => {
    const ic = await items.create({ name: 'IC', unitCost: 10, quantity: 100 });
    const withBudget = await projects.create({ name: 'Funded', budget: 100 });
    await projects.create({ name: 'Unbudgeted' }); // excluded — no budget
    const line = await projects.addLine(withBudget.id, { itemId: ic.id, requiredQty: 5 });
    await projects.receiveLine(line.id, { quantity: 2 }); // committed 20
    await projects.addExpense(withBudget.id, { amount: 15 });

    const alerts = await projects.listBudgetAlerts();
    expect(alerts.map((a) => a.projectName)).toEqual(['Funded']);
    expect(alerts[0]).toMatchObject({
      budget: 100,
      estimatedCost: 50, // 5 × 10
      committedFromBom: 20, // 2 × 10
      manualExpenseTotal: 15,
    });
  });
});
