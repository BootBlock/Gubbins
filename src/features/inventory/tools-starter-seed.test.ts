import { describe, it, expect } from 'vitest';
import { createMemoryDriver, type MemoryDriver } from '@/test/drivers/memory-driver';
import { runMigrations } from '@/db/migrations/engine';
import { migrations } from '@/db/migrations';
import { CategoryRepository } from '@/db/repositories/CategoryRepository';
import {
  applyCategoryStarterSeed,
  hasCategoryNamed,
  TOOLS_STARTER_CATEGORY_NAME,
  TOOLS_STARTER_SEED,
} from './tools-starter-seed';

describe('TOOLS_STARTER_SEED (backlog T4)', () => {
  it('pins the synthetic Tools defaults', () => {
    expect(TOOLS_STARTER_SEED.category).toEqual({
      name: 'Tools',
      defaultTrackingMode: 'SERIALISED',
      defaultCondition: 'GOOD',
      defaultWarrantyMonths: 12,
    });
    expect(TOOLS_STARTER_CATEGORY_NAME).toBe('Tools');
  });

  it('pins its two tool-ish custom fields', () => {
    expect(TOOLS_STARTER_SEED.fields).toEqual([
      { name: 'Serial number', fieldType: 'TEXT', position: 0 },
      { name: 'Calibration certificate', fieldType: 'URL', position: 1 },
    ]);
  });
});

describe('hasCategoryNamed', () => {
  it('matches case-insensitively and ignores surrounding whitespace', () => {
    expect(hasCategoryNamed(['Fasteners', 'Tools'], 'Tools')).toBe(true);
    expect(hasCategoryNamed(['tools'], 'Tools')).toBe(true);
    expect(hasCategoryNamed(['  Tools  '], 'Tools')).toBe(true);
    expect(hasCategoryNamed(['Cables', 'Fasteners'], 'Tools')).toBe(false);
    expect(hasCategoryNamed([], 'Tools')).toBe(false);
  });
});

describe('applyCategoryStarterSeed', () => {
  it('drives create + add-field in declared order and returns the new id', async () => {
    const calls: string[] = [];
    const id = await applyCategoryStarterSeed(TOOLS_STARTER_SEED, {
      createCategory: async (input) => {
        calls.push(`create:${input.name}`);
        return { id: 'cat-1' };
      },
      addField: async (categoryId, input) => {
        calls.push(`field:${categoryId}:${input.name}`);
      },
    });
    expect(id).toBe('cat-1');
    expect(calls).toEqual([
      'create:Tools',
      'field:cat-1:Serial number',
      'field:cat-1:Calibration certificate',
    ]);
  });

  it('materialises a real category with the seed defaults + fields (repository path)', async () => {
    let driver: MemoryDriver | undefined;
    try {
      driver = createMemoryDriver();
      await runMigrations(driver, migrations);
      const repo = new CategoryRepository(driver);

      const id = await applyCategoryStarterSeed(TOOLS_STARTER_SEED, {
        createCategory: (input) => repo.create(input),
        addField: (categoryId, input) => repo.addField(categoryId, input),
      });

      const created = await repo.getById(id);
      expect(created?.name).toBe('Tools');
      expect(created?.defaultTrackingMode).toBe('SERIALISED');
      expect(created?.defaultCondition).toBe('GOOD');
      expect(created?.defaultWarrantyMonths).toBe(12);

      const fields = await repo.listFields(id);
      expect(fields.map((f) => [f.name, f.fieldType])).toEqual([
        ['Serial number', 'TEXT'],
        ['Calibration certificate', 'URL'],
      ]);
    } finally {
      await driver?.close();
    }
  });
});
