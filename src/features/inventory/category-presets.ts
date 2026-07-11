/**
 * Category presets — a curated library of ready-made schemas a user can **import**
 * to give a set of items common custom fields in one step, instead of hand-assembling
 * each field. A preset is a pure, DB-free descriptor (the category, its facet defaults,
 * and its custom fields) that materialises through the ordinary create-category /
 * add-field mutation path (no bespoke repository method).
 *
 * The imported result is an ordinary {@link Category}: the fields live on the *category*
 * (`category_fields`), and every item assigned to it resolves those fields live (§4
 * lenient defaulting) — so editing the category later propagates to every item using it,
 * and the preset is never copied into individual items. A preset is just the starting
 * point; the user renames, extends, or trims the category and its fields afterwards.
 *
 * All preset data is deliberately synthetic and generic (public-repo hygiene): no real
 * brand names, URLs, or product-specific values.
 */
import type { CreateCategoryFieldInput, CreateCategoryInput } from '@/db/repositories';

/** A category-preset seed: the category (with its facet defaults) + its custom fields. */
export interface CategoryStarterSeed {
  /** The category to create, carrying its facet defaults (tracking mode, condition, …). */
  readonly category: CreateCategoryInput;
  /** The custom fields to attach, in declared order. */
  readonly fields: readonly CreateCategoryFieldInput[];
}

/**
 * A preset offered in the "Add from a preset" library: a {@link CategoryStarterSeed} plus
 * the presentation metadata the picker needs (a stable id and a one-line description).
 */
export interface CategoryPreset {
  /** Stable slug — the picker key and a durable identifier, never shown to the user. */
  readonly id: string;
  /** The category name the preset creates; also the case-insensitive idempotency key. */
  readonly name: string;
  /** One-line summary of what the preset is for, shown under its name in the picker. */
  readonly description: string;
  /** The seed materialised when the preset is imported. */
  readonly seed: CategoryStarterSeed;
}

/** Assign 0-based positions to a field list in declared order, so the preset stays terse. */
function ordered(fields: readonly Omit<CreateCategoryFieldInput, 'position'>[]): CreateCategoryFieldInput[] {
  return fields.map((field, index) => ({ ...field, position: index }));
}

/** The canonical name of the "Tools" preset category (kept for the T4 idempotency guard/tests). */
export const TOOLS_STARTER_CATEGORY_NAME = 'Tools';

/**
 * The curated preset library. Each entry is broadly useful and domain-generic; the field
 * sets cover the handful of attributes each kind of item most often needs beyond the
 * built-in facets. Ordering here is the order shown in the picker.
 */
export const CATEGORY_PRESETS: readonly CategoryPreset[] = [
  {
    id: 'tools',
    name: TOOLS_STARTER_CATEGORY_NAME,
    description: 'Serialised, loanable equipment — tracked one-by-one with a calibration record.',
    seed: {
      category: {
        name: TOOLS_STARTER_CATEGORY_NAME,
        defaultTrackingMode: 'SERIALISED',
        defaultCondition: 'GOOD',
        defaultWarrantyMonths: 12,
      },
      fields: ordered([
        { name: 'Serial number', fieldType: 'TEXT' },
        { name: 'Calibration certificate', fieldType: 'URL' },
      ]),
    },
  },
  {
    id: 'battery',
    name: 'Battery',
    description: 'Cells and packs — voltage, chemistry, capacity and form factor.',
    seed: {
      category: { name: 'Battery' },
      fields: ordered([
        { name: 'Voltage (V)', fieldType: 'NUMBER' },
        {
          name: 'Chemistry',
          fieldType: 'SELECT',
          options: ['Alkaline', 'NiMH', 'Li-ion', 'LiPo', 'Lead-acid', 'Zinc-carbon'],
        },
        { name: 'Capacity (mAh)', fieldType: 'NUMBER' },
        {
          name: 'Form factor',
          fieldType: 'SELECT',
          options: ['AA', 'AAA', 'C', 'D', '9V (PP3)', 'Coin cell', '18650', 'Custom pack'],
        },
        { name: 'Rechargeable', fieldType: 'ON_OFF' },
      ]),
    },
  },
  {
    id: 'food-pantry',
    name: 'Food',
    description: 'Pantry and perishables — expiry, storage and whether the packet is opened.',
    seed: {
      category: { name: 'Food' },
      fields: ordered([
        { name: 'Expiry date', fieldType: 'DATE' },
        { name: 'Storage', fieldType: 'SELECT', options: ['Pantry', 'Fridge', 'Freezer'] },
        { name: 'Brand', fieldType: 'TEXT' },
        { name: 'Opened', fieldType: 'ON_OFF' },
        { name: 'Allergens', fieldType: 'TEXT' },
      ]),
    },
  },
  {
    id: 'electronic-component',
    name: 'Electronic component',
    description: 'Parts for the bench — part number, datasheet, package and value.',
    seed: {
      category: { name: 'Electronic component' },
      fields: ordered([
        { name: 'Manufacturer part number', fieldType: 'TEXT' },
        { name: 'Datasheet', fieldType: 'URL' },
        { name: 'Package / footprint', fieldType: 'TEXT' },
        { name: 'Value', fieldType: 'TEXT' },
        { name: 'Tolerance', fieldType: 'TEXT' },
      ]),
    },
  },
  {
    id: 'book-media',
    name: 'Book',
    description: 'Books and reading — author, ISBN, format and a personal rating.',
    seed: {
      category: { name: 'Book' },
      fields: ordered([
        { name: 'Author', fieldType: 'TEXT' },
        { name: 'ISBN', fieldType: 'TEXT' },
        { name: 'Format', fieldType: 'SELECT', options: ['Hardback', 'Paperback', 'eBook', 'Audiobook'] },
        { name: 'Rating', fieldType: 'RATING' },
      ]),
    },
  },
  {
    id: 'clothing',
    name: 'Clothing',
    description: 'Apparel — size, colour, material and brand.',
    seed: {
      category: { name: 'Clothing' },
      fields: ordered([
        { name: 'Size', fieldType: 'SELECT', options: ['XS', 'S', 'M', 'L', 'XL', 'XXL'] },
        { name: 'Colour', fieldType: 'TEXT' },
        { name: 'Material', fieldType: 'TEXT' },
        { name: 'Brand', fieldType: 'TEXT' },
      ]),
    },
  },
  {
    id: 'cable',
    name: 'Cable',
    description: 'Leads and adaptors — connector types and length.',
    seed: {
      category: { name: 'Cable' },
      fields: ordered([
        {
          name: 'Type',
          fieldType: 'SELECT',
          options: ['USB-A', 'USB-C', 'Micro-USB', 'HDMI', 'DisplayPort', 'Ethernet', '3.5mm audio', 'Power'],
        },
        { name: 'Length (m)', fieldType: 'NUMBER' },
        { name: 'Connector A', fieldType: 'TEXT' },
        { name: 'Connector B', fieldType: 'TEXT' },
      ]),
    },
  },
  {
    id: 'fastener',
    name: 'Fastener',
    description: 'Screws, bolts and fixings — type, thread, length and material.',
    seed: {
      category: { name: 'Fastener' },
      fields: ordered([
        { name: 'Type', fieldType: 'SELECT', options: ['Screw', 'Bolt', 'Nut', 'Washer', 'Rivet', 'Anchor'] },
        { name: 'Thread size', fieldType: 'TEXT' },
        { name: 'Length (mm)', fieldType: 'NUMBER' },
        {
          name: 'Material',
          fieldType: 'SELECT',
          options: ['Steel', 'Stainless steel', 'Brass', 'Nylon', 'Aluminium'],
        },
      ]),
    },
  },
];

/**
 * The "Tools" preset seed, kept as a named export for the T4 idempotency affordance and its
 * tests. Sourced from {@link CATEGORY_PRESETS} so there is a single source of truth.
 */
export const TOOLS_STARTER_SEED: CategoryStarterSeed = CATEGORY_PRESETS[0]!.seed;

/**
 * True when a category matching the given name (case-insensitive, trimmed) already exists —
 * the idempotency guard that keeps importing a preset a second time from creating a duplicate
 * category (and lets the picker mark an already-imported preset as done).
 */
export function hasCategoryNamed(names: readonly string[], name: string): boolean {
  const target = name.trim().toLowerCase();
  return names.some((n) => n.trim().toLowerCase() === target);
}

/** Mutation-path operations `applyCategoryStarterSeed` drives (kept abstract so it stays DB-free/testable). */
export interface CategoryStarterSeedOps {
  /** Create a category, resolving to at least its new id (the ordinary create path). */
  readonly createCategory: (input: CreateCategoryInput) => Promise<{ readonly id: string }>;
  /** Attach one custom field to the given category (the ordinary add-field path). */
  readonly addField: (categoryId: string, input: CreateCategoryFieldInput) => Promise<unknown>;
}

/**
 * Materialise a preset seed through the supplied create/add-field operations, in
 * declared order, and resolve to the new category's id. Pure orchestration: it makes
 * no assumption about *where* the ops come from (React-Query mutations in the app, the
 * real repository in a test), so it needs no DB of its own.
 */
export async function applyCategoryStarterSeed(
  seed: CategoryStarterSeed,
  ops: CategoryStarterSeedOps,
): Promise<string> {
  const category = await ops.createCategory(seed.category);
  for (const field of seed.fields) {
    await ops.addField(category.id, field);
  }
  return category.id;
}
