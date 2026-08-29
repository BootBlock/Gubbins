import { describe, it, expect } from 'vitest';
import { createMemoryDriver, type MemoryDriver } from '@/test/drivers/memory-driver';
import { runMigrations } from '@/db/migrations/engine';
import { migrations } from '@/db/migrations';
import { CategoryRepository } from '@/db/repositories/CategoryRepository';
import { FIELD_DUE_LEAD_DAYS_MAX, FIELD_DUE_LEAD_DAYS_MIN, FIELD_TYPES } from '@/db/repositories';
import {
  applyCategoryStarterSeed,
  categoryPresetMatches,
  CATEGORY_PRESETS,
  hasCategoryNamed,
  PRESET_SECTION_IDS,
  TOOLS_STARTER_CATEGORY_NAME,
  TOOLS_STARTER_SEED,
  type PresetSectionId,
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

  it('ships a Movie preset that exercises the IMAGE + FILE field types (issue #453)', () => {
    const movie = CATEGORY_PRESETS.find((p) => p.id === 'movie');
    expect(movie, 'a "movie" preset must exist').toBeDefined();
    expect(movie!.name).toBe('Movie'); // deliberately not "Film"
    expect(movie!.sectionId).toBe('media');
    const types = movie!.seed.fields.map((f) => f.fieldType);
    expect(types).toContain('IMAGE'); // cover art stored in the database
    expect(types).toContain('FILE'); // link to the media file on disk
  });
});

/**
 * The parity test §3 of `docs/todo/category-presets-research_2026-08-28.md` asks for.
 *
 * A custom field is **not** owned by its category: `CategoryRepository.addField` looks the name up
 * in the shared `field_defs` dictionary, so a preset's field *names* are library-wide identities.
 * Reusing one with a different `fieldType` is rejected outright — the two presets holding it become
 * mutually exclusive, and the second import throws part-way, leaving a half-populated category
 * behind. Reusing one with the *same* type is worse, because it is silent: `options` are **not**
 * applied on reuse, so whichever preset is imported first decides what the other's dropdown offers,
 * permanently and with no error.
 *
 * The library breaks this in both directions today, and fixing every offender is deliberately out
 * of scope here — renaming a shipped field changes what an existing user's category is called.
 * So the two lists below pin the offenders **exactly**. The test therefore fails three ways, all of
 * them wanted: a *new* preset that adds a conflict, a *fix* that is not reflected here, and a
 * rename that moves the problem rather than solving it.
 *
 * Note the lists are longer than §3 reports. §3 names ten offenders — eight dual-type names plus
 * `Metal` and `Form` — but its sweep for the silent half stopped at the two it found by hand.
 * Running it exhaustively turns up fifteen names in total: seven dual-type (`Colour` was the
 * eighth, and is settled below) and twelve with divergent `SELECT` option lists, of which four
 * are in both groups. The extra six are the grading and edition vocabularies the collectibles
 * presets each spell slightly differently — `Condition`, `Rarity`, `Format`, `Finish`,
 * `Completeness`, `Movement`.
 */
describe('shared field-name parity (research doc §3)', () => {
  /** Names carrying two different `fieldType`s — the loud half: the second import throws. */
  const KNOWN_TYPE_CONFLICTS = ['Edition', 'Grade', 'Material', 'Region', 'Scale', 'Size', 'Type'];

  /** Names declared `SELECT` with two different option lists — the silent half: first import wins. */
  const KNOWN_OPTION_CONFLICTS = [
    'Completeness',
    'Condition',
    'Finish',
    'Form',
    'Format',
    'Material',
    'Metal',
    'Movement',
    'Rarity',
    'Region',
    'Scale',
    'Type',
  ];

  const typesByName = (): Map<string, Set<string>> => {
    const map = new Map<string, Set<string>>();
    for (const preset of CATEGORY_PRESETS) {
      for (const field of preset.seed.fields) {
        const seen = map.get(field.name) ?? new Set<string>();
        seen.add(field.fieldType);
        map.set(field.name, seen);
      }
    }
    return map;
  };

  it('maps every field name to exactly one field type, bar the known offenders', () => {
    const conflicts = [...typesByName()]
      .filter(([, types]) => types.size > 1)
      .map(([name]) => name)
      .sort();
    expect(conflicts).toEqual([...KNOWN_TYPE_CONFLICTS].sort());
  });

  it('gives every shared SELECT name one option list, bar the known offenders', () => {
    const listsByName = new Map<string, Set<string>>();
    for (const preset of CATEGORY_PRESETS) {
      for (const field of preset.seed.fields) {
        if (field.fieldType !== 'SELECT') continue;
        const seen = listsByName.get(field.name) ?? new Set<string>();
        // Compare the list verbatim: order is part of what the user sees in the dropdown.
        seen.add(JSON.stringify(field.options ?? []));
        listsByName.set(field.name, seen);
      }
    }
    const conflicts = [...listsByName]
      .filter(([, lists]) => lists.size > 1)
      .map(([name]) => name)
      .sort();
    expect(conflicts).toEqual([...KNOWN_OPTION_CONFLICTS].sort());
  });

  it('keeps `Colour` a single COLOUR definition, so the colour-bearing presets coexist', () => {
    // The one offender this slice settled: `Magic: The Gathering cards` used to declare `Colour`
    // as a SELECT of mana colours, which made it mutually exclusive with the ten presets that
    // share the COLOUR definition — `Yarn` among them. It is now `Card colour`.
    expect([...(typesByName().get('Colour') ?? [])]).toEqual(['COLOUR']);
    const mtg = CATEGORY_PRESETS.find((p) => p.id === 'mtg-card');
    expect(mtg, 'the Magic: The Gathering preset must exist').toBeDefined();
    expect(mtg!.seed.fields.map((f) => f.name)).toContain('Card colour');
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

/**
 * Tier 1 of `docs/todo/category-presets-research_2026-08-28.md` — the house, the car and the
 * garden. Between them these presets are the first in the library to use two category facets
 * nothing else had touched, so both are driven against the real repository rather than asserted
 * on the literal: a default maintenance schedule, and a `DATE` field's `dueLeadDays` opt-in.
 */
describe('tier 1 presets (household, home & garden, vehicle)', () => {
  it('files the twelve tier 1 presets, and fills both new sections', () => {
    const byId = new Map(CATEGORY_PRESETS.map((p) => [p.id, p]));
    const expected: Record<string, PresetSectionId> = {
      appliance: 'household',
      medication: 'household',
      'consumable-filter': 'household',
      'cleaning-chemical': 'household',
      'seed-packet': 'home-garden',
      houseplant: 'home-garden',
      vehicle: 'vehicle',
      'vehicle-part': 'vehicle',
      computer: 'electronics',
      'network-equipment': 'electronics',
      'smart-home-device': 'electronics',
      yarn: 'crafts',
    };
    for (const [id, sectionId] of Object.entries(expected)) {
      expect(byId.get(id), `preset "${id}" must exist`).toBeDefined();
      expect(byId.get(id)!.sectionId).toBe(sectionId);
    }
  });

  it('seeds a default maintenance schedule on the four presets that have an obvious one', () => {
    const schedule = (id: string) => {
      const category = CATEGORY_PRESETS.find((p) => p.id === id)!.seed.category;
      return [
        category.defaultMaintenanceBasis,
        category.defaultMaintenanceIntervalDays ?? null,
        category.defaultMaintenanceIntervalUsage ?? null,
      ];
    };
    expect(schedule('appliance')).toEqual(['TIME', 365, null]);
    expect(schedule('consumable-filter')).toEqual(['TIME', 90, null]);
    expect(schedule('houseplant')).toEqual(['TIME', 7, null]);
    // The only USAGE schedule in the library: a car is serviced by distance, not by date.
    expect(schedule('vehicle')).toEqual(['USAGE', null, 10000]);
  });

  it('opts only DATE fields into a due-date lead, within the legal range', () => {
    const withLead = CATEGORY_PRESETS.flatMap((p) =>
      p.seed.fields.filter((f) => f.dueLeadDays != null).map((f) => [p.id, f] as const),
    );
    expect(withLead.length).toBeGreaterThan(0);
    for (const [presetId, field] of withLead) {
      expect(field.fieldType, `${presetId}.${field.name} must be a DATE to carry a lead`).toBe('DATE');
      expect(field.dueLeadDays!).toBeGreaterThanOrEqual(FIELD_DUE_LEAD_DAYS_MIN);
      expect(field.dueLeadDays!).toBeLessThanOrEqual(FIELD_DUE_LEAD_DAYS_MAX);
    }
    // `Expiry date` is a shared definition: opting it in here also gives the existing `Food` and
    // `Adhesive` presets 30 days' notice. Intended, and pinned so it can't change by accident.
    const expiry = CATEGORY_PRESETS.find((p) => p.id === 'medication')!.seed.fields.find(
      (f) => f.name === 'Expiry date',
    );
    expect(expiry?.dueLeadDays).toBe(30);
  });

  it('materialises the Vehicle schedule and its due-date leads through the repository', async () => {
    let driver: MemoryDriver | undefined;
    try {
      driver = createMemoryDriver();
      await runMigrations(driver, migrations);
      const repo = new CategoryRepository(driver);
      const vehicle = CATEGORY_PRESETS.find((p) => p.id === 'vehicle')!;

      const id = await applyCategoryStarterSeed(vehicle.seed, {
        createCategory: (input) => repo.create(input),
        addField: (categoryId, input) => repo.addField(categoryId, input),
      });

      const created = await repo.getById(id);
      expect(created?.defaultMaintenanceBasis).toBe('USAGE');
      expect(created?.defaultMaintenanceIntervalUsage).toBe(10000);

      const fields = await repo.listFields(id);
      expect(fields.find((f) => f.name === 'Service due')?.dueLeadDays).toBe(30);
      expect(fields.find((f) => f.name === 'Insurance renewal')?.dueLeadDays).toBe(30);
      expect(fields.find((f) => f.name === 'Fuel')?.options).toContain('Plug-in hybrid');
      // An ordinary date stays ordinary — the opt-in is per field, not per preset.
      expect(fields.find((f) => f.name === 'Registration')?.dueLeadDays).toBeNull();
    } finally {
      await driver?.close();
    }
  });

  it('imports Yarn after a Colour-bearing preset and after the card preset (§3 Colour fix)', async () => {
    let driver: MemoryDriver | undefined;
    try {
      driver = createMemoryDriver();
      await runMigrations(driver, migrations);
      const repo = new CategoryRepository(driver);
      const ops = {
        createCategory: (input: Parameters<typeof repo.create>[0]) => repo.create(input),
        addField: (categoryId: string, input: Parameters<typeof repo.addField>[1]) =>
          repo.addField(categoryId, input),
      };
      const seedOf = (id: string) => CATEGORY_PRESETS.find((p) => p.id === id)!.seed;

      // Clothing owns `Colour` as a COLOUR field; the card preset used to claim the same name as a
      // SELECT, which made this sequence throw part-way through the third import.
      await applyCategoryStarterSeed(seedOf('clothing'), ops);
      await applyCategoryStarterSeed(seedOf('mtg-card'), ops);
      const yarnId = await applyCategoryStarterSeed(seedOf('yarn'), ops);

      const yarnFields = await repo.listFields(yarnId);
      const colour = yarnFields.find((f) => f.name === 'Colour');
      expect(colour?.fieldType).toBe('COLOUR');
      // The shared definition, not a second one: the def id is the identity inheritance keys on.
      const clothing = await repo.listFields((await repo.listAll()).find((c) => c.name === 'Clothing')!.id);
      expect(colour?.defId).toBe(clothing.find((f) => f.name === 'Colour')?.defId);
      // And the card preset kept its mana colours under its own name.
      expect(yarnFields.find((f) => f.name === 'Yarn weight')?.options).toContain('Worsted/Aran');
    } finally {
      await driver?.close();
    }
  });
});
