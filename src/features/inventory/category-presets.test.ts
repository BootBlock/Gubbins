import { describe, it, expect } from 'vitest';
import { createMemoryDriver, type MemoryDriver } from '@/test/drivers/memory-driver';
import { runMigrations } from '@/db/migrations/engine';
import { migrations } from '@/db/migrations';
import { CategoryRepository } from '@/db/repositories/CategoryRepository';
import { FIELD_TYPES } from '@/db/repositories';
import {
  applyCategoryStarterSeed,
  categoryPresetMatches,
  CATEGORY_PRESETS,
  hasCategoryNamed,
  PRESET_SECTION_IDS,
  TOOLS_STARTER_CATEGORY_NAME,
  TOOLS_STARTER_SEED,
} from './category-presets';

describe('CATEGORY_PRESETS (importable preset library)', () => {
  it('pins the synthetic Tools defaults as the first preset', () => {
    expect(CATEGORY_PRESETS[0]?.id).toBe('tools');
    expect(TOOLS_STARTER_SEED).toBe(CATEGORY_PRESETS[0]?.seed);
    expect(TOOLS_STARTER_SEED.category).toEqual({
      name: 'Tools',
      glyph: '🛠️',
      defaultTrackingMode: 'SERIALISED',
      defaultCondition: 'GOOD',
      defaultWarrantyMonths: 12,
    });
    expect(TOOLS_STARTER_CATEGORY_NAME).toBe('Tools');
    expect(TOOLS_STARTER_SEED.fields).toEqual([
      { name: 'Manufacturer', fieldType: 'TEXT', position: 0 },
      { name: 'Model number', fieldType: 'TEXT', position: 1 },
      { name: 'Serial number', fieldType: 'TEXT', position: 2 },
      { name: 'Calibration certificate', fieldType: 'URL', position: 3 },
    ]);
  });

  it('offers the headline example presets from the feature request', () => {
    const names = CATEGORY_PRESETS.map((p) => p.name);
    expect(names).toEqual(
      expect.arrayContaining(['Tools', 'Battery', 'Food', 'Electronic component', 'Book']),
    );
  });

  it('every preset is internally consistent (unique id/name, ordered valid fields)', () => {
    expect(new Set(CATEGORY_PRESETS.map((p) => p.id)).size).toBe(CATEGORY_PRESETS.length);
    expect(new Set(CATEGORY_PRESETS.map((p) => p.name.toLowerCase())).size).toBe(CATEGORY_PRESETS.length);

    for (const preset of CATEGORY_PRESETS) {
      expect(preset.id).toMatch(/^[a-z0-9-]+$/);
      expect(preset.name.trim()).not.toBe('');
      expect(preset.description.trim()).not.toBe('');
      // The category the preset creates carries its own name.
      expect(preset.seed.category.name).toBe(preset.name);
      expect(preset.seed.fields.length).toBeGreaterThan(0);

      preset.seed.fields.forEach((field, index) => {
        expect(field.name.trim()).not.toBe('');
        expect(FIELD_TYPES).toContain(field.fieldType);
        // Positions are declared 0..n-1 in order.
        expect(field.position).toBe(index);
        // A SELECT field must carry at least one option; a non-SELECT must not.
        if (field.fieldType === 'SELECT') {
          expect(field.options?.length ?? 0).toBeGreaterThan(0);
        } else {
          expect(field.options ?? null).toBeNull();
        }
      });
    }
  });

  it('gives every built-in preset a non-empty category glyph (issue #83)', () => {
    for (const preset of CATEGORY_PRESETS) {
      expect(preset.seed.category.glyph, `${preset.name} should carry a glyph`).toBeTruthy();
      expect(preset.seed.category.glyph?.trim()).not.toBe('');
    }
  });
});

describe('preset sections (the picker taxonomy)', () => {
  it('declares unique section ids', () => {
    expect(new Set(PRESET_SECTION_IDS).size).toBe(PRESET_SECTION_IDS.length);
  });

  it('files every preset under a declared section, and leaves no section empty', () => {
    for (const preset of CATEGORY_PRESETS) {
      expect(PRESET_SECTION_IDS).toContain(preset.sectionId);
    }
    for (const sectionId of PRESET_SECTION_IDS) {
      expect(
        CATEGORY_PRESETS.some((p) => p.sectionId === sectionId),
        `section "${sectionId}" must contain at least one preset`,
      ).toBe(true);
    }
  });
});

describe('categoryPresetMatches (the picker search filter)', () => {
  const tools = CATEGORY_PRESETS.find((p) => p.id === 'tools')!;
  const book = CATEGORY_PRESETS.find((p) => p.id === 'book-media')!;

  it('matches everything on an empty or whitespace-only query (the browse state)', () => {
    for (const preset of CATEGORY_PRESETS) {
      expect(categoryPresetMatches(preset, '')).toBe(true);
      expect(categoryPresetMatches(preset, '   ')).toBe(true);
    }
  });

  it('matches the name case-insensitively', () => {
    expect(categoryPresetMatches(tools, 'tOOls')).toBe(true);
    expect(categoryPresetMatches(book, 'tools')).toBe(false);
  });

  it('matches the description and the field names', () => {
    // "loanable" appears only in the Tools description; "ISBN" only in a Book field name.
    expect(categoryPresetMatches(tools, 'loanable')).toBe(true);
    expect(categoryPresetMatches(book, 'isbn')).toBe(true);
    expect(categoryPresetMatches(tools, 'isbn')).toBe(false);
  });

  it('ANDs whitespace-separated terms, in either order', () => {
    expect(categoryPresetMatches(book, 'author isbn')).toBe(true);
    expect(categoryPresetMatches(book, 'isbn author')).toBe(true);
    expect(categoryPresetMatches(book, 'isbn voltage')).toBe(false);
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
      'field:cat-1:Manufacturer',
      'field:cat-1:Model number',
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
      expect(created?.glyph).toBe('🛠️');
      expect(created?.defaultTrackingMode).toBe('SERIALISED');
      expect(created?.defaultCondition).toBe('GOOD');
      expect(created?.defaultWarrantyMonths).toBe(12);

      const fields = await repo.listFields(id);
      expect(fields.map((f) => [f.name, f.fieldType])).toEqual([
        ['Manufacturer', 'TEXT'],
        ['Model number', 'TEXT'],
        ['Serial number', 'TEXT'],
        ['Calibration certificate', 'URL'],
      ]);
    } finally {
      await driver?.close();
    }
  });

  it('materialises a SELECT-bearing preset with its options intact (Battery)', async () => {
    let driver: MemoryDriver | undefined;
    try {
      driver = createMemoryDriver();
      await runMigrations(driver, migrations);
      const repo = new CategoryRepository(driver);
      const battery = CATEGORY_PRESETS.find((p) => p.id === 'battery')!;

      const id = await applyCategoryStarterSeed(battery.seed, {
        createCategory: (input) => repo.create(input),
        addField: (categoryId, input) => repo.addField(categoryId, input),
      });

      const fields = await repo.listFields(id);
      const chemistry = fields.find((f) => f.name === 'Chemistry');
      expect(chemistry?.fieldType).toBe('SELECT');
      expect(chemistry?.options).toContain('Li-ion');
    } finally {
      await driver?.close();
    }
  });
});
