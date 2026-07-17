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
import { includesAllTerms, splitSearchTerms } from '@/lib/text-terms';

/** A category-preset seed: the category (with its facet defaults) + its custom fields. */
export interface CategoryStarterSeed {
  /** The category to create, carrying its facet defaults (tracking mode, condition, …). */
  readonly category: CreateCategoryInput;
  /** The custom fields to attach, in declared order. */
  readonly fields: readonly CreateCategoryFieldInput[];
}

/**
 * The picker's browse sections — a small, curated taxonomy that groups the preset library
 * by the kind of inventory it serves. Ids are stable slugs (durable identifiers, never shown
 * to the user); the picker resolves each to its translated label. Declared order is the
 * order the sections list shows.
 */
export const PRESET_SECTION_IDS = [
  'workshop',
  'electronics',
  'household',
  'crafts',
  'media',
  'collectibles',
] as const;

/** One of the picker's browse sections. */
export type PresetSectionId = (typeof PRESET_SECTION_IDS)[number];

/**
 * A preset offered in the "Add from a preset" library: a {@link CategoryStarterSeed} plus
 * the presentation metadata the picker needs (a stable id, the section it browses under,
 * and a one-line description).
 */
export interface CategoryPreset {
  /** Stable slug — the picker key and a durable identifier, never shown to the user. */
  readonly id: string;
  /** The category name the preset creates; also the case-insensitive idempotency key. */
  readonly name: string;
  /** One-line summary of what the preset is for, shown under its name in the picker. */
  readonly description: string;
  /** The browse section the picker files this preset under. */
  readonly sectionId: PresetSectionId;
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
    sectionId: 'workshop',
    name: TOOLS_STARTER_CATEGORY_NAME,
    description: 'Serialised, loanable equipment — tracked one-by-one with a calibration record.',
    seed: {
      category: {
        name: TOOLS_STARTER_CATEGORY_NAME,
        glyph: '🛠️',
        defaultTrackingMode: 'SERIALISED',
        defaultCondition: 'GOOD',
        defaultWarrantyMonths: 12,
      },
      fields: ordered([
        { name: 'Manufacturer', fieldType: 'TEXT' },
        { name: 'Model number', fieldType: 'TEXT' },
        { name: 'Serial number', fieldType: 'TEXT' },
        { name: 'Calibration certificate', fieldType: 'URL' },
      ]),
    },
  },
  {
    id: 'battery',
    sectionId: 'electronics',
    name: 'Battery',
    description: 'Cells and packs — voltage, chemistry, capacity and form factor.',
    seed: {
      category: { name: 'Battery', glyph: '🔋' },
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
    sectionId: 'household',
    name: 'Food',
    description: 'Pantry and perishables — expiry, storage and whether the packet is opened.',
    seed: {
      category: { name: 'Food', glyph: '🍎' },
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
    sectionId: 'electronics',
    name: 'Electronic component',
    description: 'Parts for the bench — part number, datasheet, package and value.',
    seed: {
      category: { name: 'Electronic component', glyph: '⚙️' },
      fields: ordered([
        { name: 'Manufacturer', fieldType: 'TEXT' },
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
    sectionId: 'media',
    name: 'Book',
    description: 'Books and reading — author, ISBN, format and a personal rating.',
    seed: {
      category: { name: 'Book', glyph: '📖' },
      fields: ordered([
        { name: 'Author', fieldType: 'TEXT' },
        { name: 'Publisher', fieldType: 'TEXT' },
        { name: 'Genre', fieldType: 'TEXT' },
        { name: 'ISBN', fieldType: 'TEXT' },
        { name: 'Format', fieldType: 'SELECT', options: ['Hardback', 'Paperback', 'eBook', 'Audiobook'] },
        { name: 'Read status', fieldType: 'SELECT', options: ['Unread', 'Reading', 'Read'] },
        { name: 'Rating', fieldType: 'RATING' },
      ]),
    },
  },
  {
    id: 'clothing',
    sectionId: 'household',
    name: 'Clothing',
    description: 'Apparel — size, colour, material and brand.',
    seed: {
      category: { name: 'Clothing', glyph: '👕' },
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
    sectionId: 'electronics',
    name: 'Cable',
    description: 'Leads and adaptors — connector types and length.',
    seed: {
      category: { name: 'Cable', glyph: '🔌' },
      fields: ordered([
        {
          name: 'Type',
          fieldType: 'SELECT',
          options: ['USB-A', 'USB-C', 'Micro-USB', 'HDMI', 'DisplayPort', 'Ethernet', '3.5mm audio', 'Power'],
        },
        { name: 'Length (m)', fieldType: 'NUMBER' },
        { name: 'Colour', fieldType: 'TEXT' },
        { name: 'Connector A', fieldType: 'TEXT' },
        { name: 'Connector B', fieldType: 'TEXT' },
      ]),
    },
  },
  {
    id: 'fastener',
    sectionId: 'workshop',
    name: 'Fastener',
    description: 'Screws, bolts and fixings — type, thread, length and material.',
    seed: {
      category: { name: 'Fastener', glyph: '🔩' },
      fields: ordered([
        { name: 'Type', fieldType: 'SELECT', options: ['Screw', 'Bolt', 'Nut', 'Washer', 'Rivet', 'Anchor'] },
        {
          name: 'Drive type',
          fieldType: 'SELECT',
          options: ['Phillips', 'Slotted', 'Pozi', 'Hex / Allen', 'Torx', 'Square'],
        },
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
  {
    id: '3d-filament',
    sectionId: 'crafts',
    name: '3D Filament',
    description: '3D-printer filament spools — material, diameter, colour and print settings.',
    seed: {
      category: { name: '3D Filament', glyph: '🧵' },
      fields: ordered([
        { name: 'Brand', fieldType: 'TEXT' },
        {
          name: 'Material',
          fieldType: 'SELECT',
          options: ['PLA', 'PETG', 'ABS', 'ASA', 'TPU', 'Nylon', 'PVA', 'PC'],
        },
        { name: 'Diameter (mm)', fieldType: 'SELECT', options: ['1.75', '2.85'] },
        { name: 'Colour', fieldType: 'TEXT' },
        { name: 'Spool weight (g)', fieldType: 'NUMBER' },
        { name: 'Print temperature (°C)', fieldType: 'NUMBER' },
        { name: 'Bed temperature (°C)', fieldType: 'NUMBER' },
      ]),
    },
  },
  {
    id: 'fabric',
    sectionId: 'crafts',
    name: 'Fabric',
    description: 'Sewing and craft fabric — material, width, colour and pattern.',
    seed: {
      category: { name: 'Fabric', glyph: '🧶' },
      fields: ordered([
        {
          name: 'Material',
          fieldType: 'SELECT',
          options: ['Cotton', 'Linen', 'Wool', 'Silk', 'Polyester', 'Fleece', 'Denim', 'Felt'],
        },
        { name: 'Width (cm)', fieldType: 'NUMBER' },
        { name: 'Colour', fieldType: 'TEXT' },
        { name: 'Pattern', fieldType: 'TEXT' },
        { name: 'Stretch', fieldType: 'ON_OFF' },
      ]),
    },
  },
  {
    id: 'hobby-paint',
    sectionId: 'crafts',
    name: 'Paint',
    description: 'Hobby and craft paint — brand, colour, finish and type.',
    seed: {
      category: { name: 'Paint', glyph: '🎨' },
      fields: ordered([
        { name: 'Brand', fieldType: 'TEXT' },
        { name: 'Colour name', fieldType: 'TEXT' },
        {
          name: 'Type',
          fieldType: 'SELECT',
          options: ['Acrylic', 'Enamel', 'Lacquer', 'Watercolour', 'Oil', 'Spray'],
        },
        {
          name: 'Finish',
          fieldType: 'SELECT',
          options: ['Matte', 'Satin', 'Gloss', 'Metallic', 'Fluorescent'],
        },
        { name: 'Volume (ml)', fieldType: 'NUMBER' },
      ]),
    },
  },
  {
    id: 'adhesive',
    sectionId: 'workshop',
    name: 'Adhesive',
    description: 'Glues, resins and tapes — type, cure time and shelf life.',
    seed: {
      category: { name: 'Adhesive', glyph: '🧴' },
      fields: ordered([
        {
          name: 'Type',
          fieldType: 'SELECT',
          options: ['Super glue', 'Epoxy', 'UV resin', 'Wood glue', 'Hot glue', 'Contact adhesive', 'Tape'],
        },
        { name: 'Cure time (min)', fieldType: 'NUMBER' },
        { name: 'Expiry date', fieldType: 'DATE' },
        { name: 'Opened', fieldType: 'ON_OFF' },
      ]),
    },
  },
  {
    id: 'model-kit',
    sectionId: 'crafts',
    name: 'Model kit',
    description: 'Scale model kits — manufacturer, scale, subject and build status.',
    seed: {
      category: { name: 'Model kit', glyph: '🧩' },
      fields: ordered([
        { name: 'Manufacturer', fieldType: 'TEXT' },
        { name: 'Kit number', fieldType: 'TEXT' },
        {
          name: 'Scale',
          fieldType: 'SELECT',
          options: ['1:24', '1:32', '1:35', '1:48', '1:72', '1:144', '1:700', 'Other'],
        },
        { name: 'Subject', fieldType: 'TEXT' },
        {
          name: 'Build status',
          fieldType: 'SELECT',
          options: ['Unbuilt', 'In progress', 'Built', 'Painted'],
        },
      ]),
    },
  },
  {
    id: 'trading-card',
    sectionId: 'collectibles',
    name: 'Trading card',
    description: 'Collectible cards — set, rarity, condition and language.',
    seed: {
      category: { name: 'Trading card', glyph: '🃏' },
      fields: ordered([
        { name: 'Set / expansion', fieldType: 'TEXT' },
        { name: 'Card number', fieldType: 'TEXT' },
        {
          name: 'Rarity',
          fieldType: 'SELECT',
          options: ['Common', 'Uncommon', 'Rare', 'Holo rare', 'Ultra rare', 'Secret rare'],
        },
        {
          name: 'Condition',
          fieldType: 'SELECT',
          options: ['Mint', 'Near mint', 'Excellent', 'Good', 'Played', 'Poor'],
        },
        { name: 'Language', fieldType: 'TEXT' },
        { name: 'Graded', fieldType: 'ON_OFF' },
        { name: 'Grade', fieldType: 'TEXT' },
      ]),
    },
  },
  {
    id: 'vinyl-record',
    sectionId: 'media',
    name: 'Vinyl record',
    description: 'Records — artist, format, speed and condition.',
    seed: {
      category: { name: 'Vinyl record', glyph: '💿' },
      fields: ordered([
        { name: 'Artist', fieldType: 'TEXT' },
        { name: 'Label', fieldType: 'TEXT' },
        { name: 'Format', fieldType: 'SELECT', options: ['LP', 'EP', 'Single', 'Box set'] },
        { name: 'Speed', fieldType: 'SELECT', options: ['33⅓ RPM', '45 RPM', '78 RPM'] },
        {
          name: 'Media condition',
          fieldType: 'SELECT',
          options: ['Mint', 'Near mint', 'Very good plus', 'Very good', 'Good', 'Poor'],
        },
        {
          name: 'Sleeve condition',
          fieldType: 'SELECT',
          options: ['Mint', 'Near mint', 'Very good plus', 'Very good', 'Good', 'Poor'],
        },
        { name: 'Catalogue number', fieldType: 'TEXT' },
      ]),
    },
  },
  {
    id: 'coin',
    sectionId: 'collectibles',
    name: 'Coin',
    description: 'Coins — country, year, denomination and grade.',
    seed: {
      category: { name: 'Coin', glyph: '🪙' },
      fields: ordered([
        { name: 'Country', fieldType: 'TEXT' },
        { name: 'Year', fieldType: 'NUMBER' },
        { name: 'Denomination', fieldType: 'TEXT' },
        { name: 'Mint mark', fieldType: 'TEXT' },
        {
          name: 'Metal',
          fieldType: 'SELECT',
          options: ['Gold', 'Silver', 'Copper', 'Bronze', 'Nickel', 'Cupronickel', 'Other'],
        },
        { name: 'Grade', fieldType: 'TEXT' },
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

/**
 * Whether a preset matches the picker's search text — the shared term-AND-substring
 * model (`@/lib/text-terms`, the same matcher the glyph picker filters with) applied
 * to the preset's haystack: its name, description and field names. So "isbn" finds the
 * Book preset via its ISBN field, "expiry" finds Food and Adhesive, and either word
 * order works. An empty/whitespace query matches everything (the picker's browse
 * state). Pure, so the matching rules are unit-testable without the UI.
 */
export function categoryPresetMatches(preset: CategoryPreset, query: string): boolean {
  const hay = [preset.name, preset.description, ...preset.seed.fields.map((f) => f.name)].join(' ');
  return includesAllTerms(hay, splitSearchTerms(query));
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
