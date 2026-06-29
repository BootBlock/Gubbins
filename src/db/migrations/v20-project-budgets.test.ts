import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createMemoryDriver, type MemoryDriver } from '@/test/drivers/memory-driver';
import { runMigrations } from './engine';
import { migrations } from './index';

describe('v20 project-budgets migration', () => {
  let driver: MemoryDriver;

  beforeEach(async () => {
    driver = createMemoryDriver();
    // Narrowed to <= 20 so the "reaches version 20" assertion survives later bumps.
    await runMigrations(
      driver,
      migrations.filter((m) => m.version <= 20),
    );
    await driver.execute('PRAGMA foreign_keys = ON;');
  });

  afterEach(async () => {
    await driver.close();
  });

  it('reaches schema version 20 and registers v20 last', async () => {
    const row = await driver.queryOne<{ user_version: number }>('PRAGMA user_version;');
    expect(Number(row?.user_version)).toBe(20);
    const v20 = migrations.find((m) => m.version === 20);
    expect(v20?.name).toBe('project-budgets');
  });

  it('adds a nullable projects.budget column (no backfill)', async () => {
    const cols = await driver.query<{ name: string; notnull: number; dflt_value: string | null }>(
      'PRAGMA table_info(projects);',
    );
    const budget = cols.find((c) => c.name === 'budget');
    expect(budget, 'expected projects.budget column').toBeDefined();
    expect(budget?.notnull).toBe(0);
    expect(budget?.dflt_value).toBeNull();
  });

  it('defaults budget to NULL for a legacy-style project row', async () => {
    await driver.execute('INSERT INTO projects (id, name) VALUES (?, ?);', ['p-a', 'Amp build']);
    const row = await driver.queryOne<{ budget: number | null }>(
      'SELECT budget FROM projects WHERE id = ?;',
      ['p-a'],
    );
    expect(row?.budget).toBeNull();
  });

  it('stores an overall budget on a project', async () => {
    await driver.execute('INSERT INTO projects (id, name, budget) VALUES (?, ?, ?);', [
      'p-b',
      'Synth',
      500,
    ]);
    const row = await driver.queryOne<{ budget: number | null }>(
      'SELECT budget FROM projects WHERE id = ?;',
      ['p-b'],
    );
    expect(row?.budget).toBe(500);
  });

  it('creates project_budget_categories and project_expenses tables', async () => {
    const tables = await driver.query<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN (?, ?);",
      ['project_budget_categories', 'project_expenses'],
    );
    const names = tables.map((t) => t.name).sort();
    expect(names).toEqual(['project_budget_categories', 'project_expenses']);
  });

  it('cascades categories and expenses when a project is deleted', async () => {
    await driver.execute('INSERT INTO projects (id, name) VALUES (?, ?);', ['p-c', 'Rig']);
    await driver.execute(
      'INSERT INTO project_budget_categories (id, project_id, name, amount) VALUES (?, ?, ?, ?);',
      ['cat-1', 'p-c', 'Parts', 300],
    );
    await driver.execute(
      'INSERT INTO project_expenses (id, project_id, category_id, description, amount) VALUES (?, ?, ?, ?, ?);',
      ['exp-1', 'p-c', 'cat-1', 'PCB order', 95],
    );

    await driver.execute('DELETE FROM projects WHERE id = ?;', ['p-c']);

    const cats = await driver.query('SELECT id FROM project_budget_categories WHERE project_id = ?;', [
      'p-c',
    ]);
    const exps = await driver.query('SELECT id FROM project_expenses WHERE project_id = ?;', ['p-c']);
    expect(cats).toHaveLength(0);
    expect(exps).toHaveLength(0);
  });

  it('un-categorises (SET NULL) an expense when its category is deleted', async () => {
    await driver.execute('INSERT INTO projects (id, name) VALUES (?, ?);', ['p-d', 'Bench']);
    await driver.execute(
      'INSERT INTO project_budget_categories (id, project_id, name, amount) VALUES (?, ?, ?, ?);',
      ['cat-2', 'p-d', 'Shipping', 50],
    );
    await driver.execute(
      'INSERT INTO project_expenses (id, project_id, category_id, description, amount) VALUES (?, ?, ?, ?, ?);',
      ['exp-2', 'p-d', 'cat-2', 'Courier', 12],
    );

    await driver.execute('DELETE FROM project_budget_categories WHERE id = ?;', ['cat-2']);

    const row = await driver.queryOne<{ category_id: string | null }>(
      'SELECT category_id FROM project_expenses WHERE id = ?;',
      ['exp-2'],
    );
    // The expense survives (the spend is real) but loses its category reference.
    expect(row).toBeDefined();
    expect(row?.category_id).toBeNull();
  });

  it('rejects a negative budget-category amount and a negative expense amount', async () => {
    await driver.execute('INSERT INTO projects (id, name) VALUES (?, ?);', ['p-e', 'Neg']);
    await expect(
      driver.execute(
        'INSERT INTO project_budget_categories (id, project_id, name, amount) VALUES (?, ?, ?, ?);',
        ['cat-neg', 'p-e', 'Bad', -1],
      ),
    ).rejects.toThrow();
    await expect(
      driver.execute(
        'INSERT INTO project_expenses (id, project_id, amount) VALUES (?, ?, ?);',
        ['exp-neg', 'p-e', -1],
      ),
    ).rejects.toThrow();
  });

  it('auto-stamps updated_at on an expense modification (§7.1 LWW)', async () => {
    await driver.execute('INSERT INTO projects (id, name) VALUES (?, ?);', ['p-f', 'Stamp']);
    await driver.execute(
      'INSERT INTO project_expenses (id, project_id, amount, updated_at) VALUES (?, ?, ?, ?);',
      ['exp-3', 'p-f', 10, 1],
    );
    await driver.execute('UPDATE project_expenses SET amount = ? WHERE id = ?;', [20, 'exp-3']);
    const row = await driver.queryOne<{ updated_at: number }>(
      'SELECT updated_at FROM project_expenses WHERE id = ?;',
      ['exp-3'],
    );
    // The pass-through guard re-stamps because the UPDATE left updated_at unchanged.
    expect(Number(row?.updated_at)).toBeGreaterThan(1);
  });
});
