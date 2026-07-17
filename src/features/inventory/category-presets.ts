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
  {
    id: 'banknote',
    sectionId: 'collectibles',
    name: 'Banknote',
    description: 'Paper currency — country, denomination, serial and grade.',
    seed: {
      category: { name: 'Banknote', glyph: '💵' },
      fields: ordered([
        { name: 'Country', fieldType: 'TEXT' },
        { name: 'Year', fieldType: 'NUMBER' },
        { name: 'Denomination', fieldType: 'TEXT' },
        { name: 'Serial number', fieldType: 'TEXT' },
        {
          name: 'Grade',
          fieldType: 'SELECT',
          options: ['Uncirculated', 'Extremely fine', 'Very fine', 'Fine', 'Good', 'Poor'],
        },
        { name: 'Signature', fieldType: 'TEXT' },
      ]),
    },
  },
  {
    id: 'action-figure',
    sectionId: 'collectibles',
    name: 'Action figures',
    description: 'Figures and characters — line, scale and boxed condition.',
    seed: {
      category: { name: 'Action figures', glyph: '🦸' },
      fields: ordered([
        { name: 'Manufacturer', fieldType: 'TEXT' },
        { name: 'Character', fieldType: 'TEXT' },
        { name: 'Series / line', fieldType: 'TEXT' },
        { name: 'Scale', fieldType: 'TEXT' },
        {
          name: 'Condition',
          fieldType: 'SELECT',
          options: ['Mint on card', 'Mint in box', 'Loose complete', 'Loose incomplete', 'Damaged'],
        },
      ]),
    },
  },
  {
    id: 'antique-furniture',
    sectionId: 'collectibles',
    name: 'Antique furniture',
    description: 'Period pieces — style, wood, maker and provenance.',
    seed: {
      category: { name: 'Antique furniture', glyph: '🪑', defaultTrackingMode: 'SERIALISED' },
      fields: ordered([
        {
          name: 'Period / style',
          fieldType: 'SELECT',
          options: ['Georgian', 'Victorian', 'Edwardian', 'Art Deco', 'Mid-century', 'Other'],
        },
        { name: 'Wood / material', fieldType: 'TEXT' },
        { name: 'Maker', fieldType: 'TEXT' },
        { name: 'Approx. year', fieldType: 'NUMBER' },
        { name: 'Provenance', fieldType: 'LONG_TEXT' },
        { name: 'Restored', fieldType: 'ON_OFF' },
      ]),
    },
  },
  {
    id: 'autograph',
    sectionId: 'collectibles',
    name: 'Autographs & signed memorabilia',
    description: 'Signed items — signer, authenticity and condition.',
    seed: {
      category: { name: 'Autographs & signed memorabilia', glyph: '✍️', defaultTrackingMode: 'SERIALISED' },
      fields: ordered([
        { name: 'Signed by', fieldType: 'TEXT' },
        { name: 'Item type', fieldType: 'TEXT' },
        { name: 'Date signed', fieldType: 'DATE' },
        { name: 'Certificate of authenticity', fieldType: 'URL' },
        { name: 'Authenticated', fieldType: 'ON_OFF' },
        {
          name: 'Condition',
          fieldType: 'SELECT',
          options: ['Mint', 'Near mint', 'Excellent', 'Very good', 'Good', 'Fair', 'Poor'],
        },
      ]),
    },
  },
  {
    id: 'baseball-card',
    sectionId: 'collectibles',
    name: 'Baseball cards',
    description: 'Sports cards — player, set, grade and rookie status.',
    seed: {
      category: { name: 'Baseball cards', glyph: '⚾' },
      fields: ordered([
        { name: 'Player', fieldType: 'TEXT' },
        { name: 'Set / year', fieldType: 'TEXT' },
        { name: 'Card number', fieldType: 'TEXT' },
        { name: 'Manufacturer', fieldType: 'TEXT' },
        { name: 'Grade', fieldType: 'TEXT' },
        { name: 'Graded', fieldType: 'ON_OFF' },
        { name: 'Rookie card', fieldType: 'ON_OFF' },
      ]),
    },
  },
  {
    id: 'board-game',
    sectionId: 'collectibles',
    name: 'Board games',
    description: 'Tabletop games — publisher, players and completeness.',
    seed: {
      category: { name: 'Board games', glyph: '🎲' },
      fields: ordered([
        { name: 'Publisher', fieldType: 'TEXT' },
        { name: 'Designer', fieldType: 'TEXT' },
        { name: 'Players', fieldType: 'TEXT' },
        { name: 'Play time (min)', fieldType: 'NUMBER' },
        {
          name: 'Completeness',
          fieldType: 'SELECT',
          options: ['Sealed', 'Complete', 'Missing pieces'],
        },
        { name: 'Rating', fieldType: 'RATING' },
      ]),
    },
  },
  {
    id: 'blu-ray',
    sectionId: 'media',
    name: 'Blu-rays',
    description: 'Blu-ray discs — title, studio, region and format.',
    seed: {
      category: { name: 'Blu-rays', glyph: '🎬' },
      fields: ordered([
        { name: 'Title', fieldType: 'TEXT' },
        { name: 'Director', fieldType: 'TEXT' },
        { name: 'Studio', fieldType: 'TEXT' },
        { name: 'Region', fieldType: 'SELECT', options: ['A', 'B', 'C', 'Free'] },
        {
          name: 'Format',
          fieldType: 'SELECT',
          options: ['Blu-ray', '4K UHD', '3D Blu-ray'],
        },
        { name: 'Sealed', fieldType: 'ON_OFF' },
      ]),
    },
  },
  {
    id: 'comic-book',
    sectionId: 'collectibles',
    name: 'Comic books',
    description: 'Comics — title, issue, grade and key-issue status.',
    seed: {
      category: { name: 'Comic books', glyph: '📚' },
      fields: ordered([
        { name: 'Title', fieldType: 'TEXT' },
        { name: 'Publisher', fieldType: 'TEXT' },
        { name: 'Issue number', fieldType: 'TEXT' },
        { name: 'Grade', fieldType: 'TEXT' },
        { name: 'Graded / slabbed', fieldType: 'ON_OFF' },
        { name: 'Key issue', fieldType: 'ON_OFF' },
      ]),
    },
  },
  {
    id: 'copperware',
    sectionId: 'collectibles',
    name: 'Copperware & brass ornaments',
    description: 'Metalware — metal, maker, origin and condition.',
    seed: {
      category: { name: 'Copperware & brass ornaments', glyph: '🫖' },
      fields: ordered([
        { name: 'Metal', fieldType: 'SELECT', options: ['Copper', 'Brass', 'Bronze', 'Mixed'] },
        { name: 'Maker', fieldType: 'TEXT' },
        { name: 'Origin', fieldType: 'TEXT' },
        { name: 'Approx. year', fieldType: 'NUMBER' },
        { name: 'Weight (g)', fieldType: 'NUMBER' },
        {
          name: 'Condition',
          fieldType: 'SELECT',
          options: ['Mint', 'Near mint', 'Excellent', 'Very good', 'Good', 'Fair', 'Poor'],
        },
      ]),
    },
  },
  {
    id: 'mineral-gemstone',
    sectionId: 'collectibles',
    name: 'Crystals, minerals & gemstones',
    description: 'Specimens — species, locality, weight and form.',
    seed: {
      category: { name: 'Crystals, minerals & gemstones', glyph: '💎' },
      fields: ordered([
        { name: 'Mineral / species', fieldType: 'TEXT' },
        { name: 'Origin / locality', fieldType: 'TEXT' },
        { name: 'Weight (ct)', fieldType: 'NUMBER' },
        { name: 'Colour', fieldType: 'TEXT' },
        {
          name: 'Cut / form',
          fieldType: 'SELECT',
          options: ['Raw / rough', 'Tumbled', 'Cabochon', 'Faceted', 'Cluster', 'Point'],
        },
        { name: 'Certified', fieldType: 'ON_OFF' },
      ]),
    },
  },
  {
    id: 'die-cast-car',
    sectionId: 'collectibles',
    name: 'Die-cast model cars',
    description: 'Die-cast vehicles — maker, scale and boxed condition.',
    seed: {
      category: { name: 'Die-cast model cars', glyph: '🚗' },
      fields: ordered([
        { name: 'Manufacturer', fieldType: 'TEXT' },
        { name: 'Model', fieldType: 'TEXT' },
        { name: 'Scale', fieldType: 'SELECT', options: ['1:18', '1:24', '1:43', '1:64', 'Other'] },
        { name: 'Colour', fieldType: 'TEXT' },
        { name: 'Boxed', fieldType: 'ON_OFF' },
        {
          name: 'Condition',
          fieldType: 'SELECT',
          options: ['Mint boxed', 'Mint', 'Played with', 'Damaged'],
        },
      ]),
    },
  },
  {
    id: 'nft-digital-art',
    sectionId: 'collectibles',
    name: 'Digital & generative art (NFTs)',
    description: 'Tokenised art — artist, chain, token and marketplace.',
    seed: {
      category: { name: 'Digital & generative art (NFTs)', glyph: '🖥️' },
      fields: ordered([
        { name: 'Artist', fieldType: 'TEXT' },
        { name: 'Collection', fieldType: 'TEXT' },
        { name: 'Token ID', fieldType: 'TEXT' },
        {
          name: 'Blockchain',
          fieldType: 'SELECT',
          options: ['Ethereum', 'Solana', 'Polygon', 'Tezos', 'Bitcoin', 'Other'],
        },
        { name: 'Token standard', fieldType: 'TEXT' },
        { name: 'Marketplace link', fieldType: 'URL' },
        { name: 'Edition', fieldType: 'TEXT' },
      ]),
    },
  },
  {
    id: 'dvd',
    sectionId: 'media',
    name: 'DVDs',
    description: 'DVD discs — title, studio and region.',
    seed: {
      category: { name: 'DVDs', glyph: '📀' },
      fields: ordered([
        { name: 'Title', fieldType: 'TEXT' },
        { name: 'Director', fieldType: 'TEXT' },
        { name: 'Studio', fieldType: 'TEXT' },
        {
          name: 'Region',
          fieldType: 'SELECT',
          options: ['Region 1', 'Region 2', 'Region 3', 'Region 4', 'Region free'],
        },
        { name: 'Sealed', fieldType: 'ON_OFF' },
      ]),
    },
  },
  {
    id: 'enamel-pin',
    sectionId: 'collectibles',
    name: 'Enamel pin badges',
    description: 'Pin badges — design, maker, type and edition.',
    seed: {
      category: { name: 'Enamel pin badges', glyph: '📌' },
      fields: ordered([
        { name: 'Design / name', fieldType: 'TEXT' },
        { name: 'Maker', fieldType: 'TEXT' },
        { name: 'Series', fieldType: 'TEXT' },
        {
          name: 'Type',
          fieldType: 'SELECT',
          options: ['Hard enamel', 'Soft enamel', 'Cloisonné', 'Screen-printed'],
        },
        { name: 'Limited edition', fieldType: 'ON_OFF' },
        {
          name: 'Condition',
          fieldType: 'SELECT',
          options: ['Mint', 'Near mint', 'Excellent', 'Very good', 'Good', 'Fair', 'Poor'],
        },
      ]),
    },
  },
  {
    id: 'edc-gear',
    sectionId: 'collectibles',
    name: 'Everyday Carry (EDC) gear',
    description: 'Pocket kit — type, brand, model and material.',
    seed: {
      category: { name: 'Everyday Carry (EDC) gear', glyph: '🔦' },
      fields: ordered([
        {
          name: 'Type',
          fieldType: 'SELECT',
          options: ['Knife', 'Multi-tool', 'Flashlight', 'Wallet', 'Pen', 'Watch', 'Other'],
        },
        { name: 'Brand', fieldType: 'TEXT' },
        { name: 'Model', fieldType: 'TEXT' },
        { name: 'Material', fieldType: 'TEXT' },
        { name: 'Everyday carry', fieldType: 'ON_OFF' },
      ]),
    },
  },
  {
    id: 'fossil-meteorite',
    sectionId: 'collectibles',
    name: 'Fossils & meteorites',
    description: 'Natural specimens — type, locality, age and weight.',
    seed: {
      category: { name: 'Fossils & meteorites', glyph: '🪨' },
      fields: ordered([
        { name: 'Type', fieldType: 'SELECT', options: ['Fossil', 'Meteorite', 'Tektite'] },
        { name: 'Species / classification', fieldType: 'TEXT' },
        { name: 'Origin / locality', fieldType: 'TEXT' },
        { name: 'Age / period', fieldType: 'TEXT' },
        { name: 'Weight (g)', fieldType: 'NUMBER' },
        { name: 'Certified', fieldType: 'ON_OFF' },
      ]),
    },
  },
  {
    id: 'fountain-pen',
    sectionId: 'collectibles',
    name: 'Fountain pens',
    description: 'Fountain pens — brand, nib, filling system and condition.',
    seed: {
      category: { name: 'Fountain pens', glyph: '🖋️', defaultTrackingMode: 'SERIALISED' },
      fields: ordered([
        { name: 'Brand', fieldType: 'TEXT' },
        { name: 'Model', fieldType: 'TEXT' },
        {
          name: 'Nib size',
          fieldType: 'SELECT',
          options: ['Extra fine', 'Fine', 'Medium', 'Broad', 'Stub', 'Italic'],
        },
        { name: 'Nib material', fieldType: 'SELECT', options: ['Steel', 'Gold', 'Titanium', 'Other'] },
        {
          name: 'Filling system',
          fieldType: 'SELECT',
          options: ['Cartridge', 'Converter', 'Piston', 'Vacuum', 'Eyedropper'],
        },
        {
          name: 'Condition',
          fieldType: 'SELECT',
          options: ['Mint', 'Near mint', 'Excellent', 'Very good', 'Good', 'Fair', 'Poor'],
        },
      ]),
    },
  },
  {
    id: 'fridge-magnet',
    sectionId: 'collectibles',
    name: 'Fridge magnets',
    description: 'Souvenir magnets — theme, origin and material.',
    seed: {
      category: { name: 'Fridge magnets', glyph: '🧲' },
      fields: ordered([
        { name: 'Theme / subject', fieldType: 'TEXT' },
        { name: 'Origin / place', fieldType: 'TEXT' },
        {
          name: 'Material',
          fieldType: 'SELECT',
          options: ['Ceramic', 'Resin', 'Metal', 'Acrylic', 'Wood', 'Rubber'],
        },
        {
          name: 'Condition',
          fieldType: 'SELECT',
          options: ['Mint', 'Near mint', 'Excellent', 'Very good', 'Good', 'Fair', 'Poor'],
        },
      ]),
    },
  },
  {
    id: 'funko-pop',
    sectionId: 'collectibles',
    name: 'Funko Pop figures',
    description: 'Vinyl figures — character, number, exclusive and box.',
    seed: {
      category: { name: 'Funko Pop figures', glyph: '🧸' },
      fields: ordered([
        { name: 'Character', fieldType: 'TEXT' },
        { name: 'Series / franchise', fieldType: 'TEXT' },
        { name: 'Pop number', fieldType: 'TEXT' },
        { name: 'Exclusive', fieldType: 'ON_OFF' },
        { name: 'Vaulted', fieldType: 'ON_OFF' },
        {
          name: 'Box condition',
          fieldType: 'SELECT',
          options: ['Mint', 'Good', 'Damaged', 'No box'],
        },
      ]),
    },
  },
  {
    id: 'bullion',
    sectionId: 'collectibles',
    name: 'Gold & silver bullion',
    description: 'Precious metal — metal, form, weight and fineness.',
    seed: {
      category: { name: 'Gold & silver bullion', glyph: '🥇', defaultTrackingMode: 'SERIALISED' },
      fields: ordered([
        { name: 'Metal', fieldType: 'SELECT', options: ['Gold', 'Silver', 'Platinum', 'Palladium'] },
        { name: 'Form', fieldType: 'SELECT', options: ['Coin', 'Bar', 'Round', 'Ingot'] },
        {
          name: 'Weight',
          fieldType: 'SELECT',
          options: ['1 g', '5 g', '10 g', '1 oz', '10 oz', '100 g', '1 kg', 'Other'],
        },
        { name: 'Purity / fineness', fieldType: 'TEXT' },
        { name: 'Mint / refiner', fieldType: 'TEXT' },
        { name: 'Serial number', fieldType: 'TEXT' },
      ]),
    },
  },
  {
    id: 'handbag',
    sectionId: 'collectibles',
    name: 'Handbags',
    description: 'Designer bags — brand, style, date code and condition.',
    seed: {
      category: { name: 'Handbags', glyph: '👜', defaultTrackingMode: 'SERIALISED' },
      fields: ordered([
        { name: 'Brand', fieldType: 'TEXT' },
        { name: 'Model / style', fieldType: 'TEXT' },
        { name: 'Material', fieldType: 'TEXT' },
        { name: 'Colour', fieldType: 'TEXT' },
        { name: 'Serial / date code', fieldType: 'TEXT' },
        { name: 'Authenticated', fieldType: 'ON_OFF' },
        {
          name: 'Condition',
          fieldType: 'SELECT',
          options: ['Mint', 'Near mint', 'Excellent', 'Very good', 'Good', 'Fair', 'Poor'],
        },
      ]),
    },
  },
  {
    id: 'lego-set',
    sectionId: 'collectibles',
    name: 'LEGO sets',
    description: 'Brick sets — set number, theme, pieces and completeness.',
    seed: {
      category: { name: 'LEGO sets', glyph: '🧱' },
      fields: ordered([
        { name: 'Set number', fieldType: 'TEXT' },
        { name: 'Theme', fieldType: 'TEXT' },
        { name: 'Piece count', fieldType: 'NUMBER' },
        { name: 'Minifigures', fieldType: 'NUMBER' },
        {
          name: 'Completeness',
          fieldType: 'SELECT',
          options: ['Sealed', 'Complete', 'Incomplete', 'Bulk'],
        },
        { name: 'Instructions', fieldType: 'ON_OFF' },
        { name: 'Box', fieldType: 'ON_OFF' },
      ]),
    },
  },
  {
    id: 'luxury-watch',
    sectionId: 'collectibles',
    name: 'Luxury watches',
    description: 'Fine watches — brand, reference, movement and papers.',
    seed: {
      category: { name: 'Luxury watches', glyph: '⌚', defaultTrackingMode: 'SERIALISED' },
      fields: ordered([
        { name: 'Brand', fieldType: 'TEXT' },
        { name: 'Model', fieldType: 'TEXT' },
        { name: 'Reference number', fieldType: 'TEXT' },
        { name: 'Serial number', fieldType: 'TEXT' },
        {
          name: 'Movement',
          fieldType: 'SELECT',
          options: ['Automatic', 'Manual', 'Quartz', 'Spring drive'],
        },
        { name: 'Box & papers', fieldType: 'ON_OFF' },
        {
          name: 'Condition',
          fieldType: 'SELECT',
          options: ['Mint', 'Near mint', 'Excellent', 'Very good', 'Good', 'Fair', 'Poor'],
        },
      ]),
    },
  },
  {
    id: 'mtg-card',
    sectionId: 'collectibles',
    name: 'Magic: The Gathering cards',
    description: 'MTG cards — set, rarity, colour, foil and condition.',
    seed: {
      category: { name: 'Magic: The Gathering cards', glyph: '🎴' },
      fields: ordered([
        { name: 'Card name', fieldType: 'TEXT' },
        { name: 'Set / expansion', fieldType: 'TEXT' },
        {
          name: 'Rarity',
          fieldType: 'SELECT',
          options: ['Common', 'Uncommon', 'Rare', 'Mythic rare', 'Special'],
        },
        {
          name: 'Colour',
          fieldType: 'SELECT',
          options: ['White', 'Blue', 'Black', 'Red', 'Green', 'Multicolour', 'Colourless'],
        },
        { name: 'Foil', fieldType: 'ON_OFF' },
        {
          name: 'Condition',
          fieldType: 'SELECT',
          options: ['Mint', 'Near mint', 'Lightly played', 'Moderately played', 'Heavily played', 'Damaged'],
        },
        { name: 'Language', fieldType: 'TEXT' },
      ]),
    },
  },
  {
    id: 'matchbook',
    sectionId: 'collectibles',
    name: 'Matchbooks & matchboxes',
    description: 'Phillumeny — advertiser, origin, type and completeness.',
    seed: {
      category: { name: 'Matchbooks & matchboxes', glyph: '🔥' },
      fields: ordered([
        { name: 'Brand / advertiser', fieldType: 'TEXT' },
        { name: 'Origin', fieldType: 'TEXT' },
        {
          name: 'Type',
          fieldType: 'SELECT',
          options: ['Matchbook', 'Matchbox', 'Match label'],
        },
        { name: 'Theme', fieldType: 'TEXT' },
        { name: 'Complete', fieldType: 'ON_OFF' },
        {
          name: 'Condition',
          fieldType: 'SELECT',
          options: ['Mint', 'Near mint', 'Excellent', 'Very good', 'Good', 'Fair', 'Poor'],
        },
      ]),
    },
  },
  {
    id: 'mechanical-watch',
    sectionId: 'collectibles',
    name: 'Mechanical wrist watches',
    description: 'Mechanical watches — brand, movement, calibre and condition.',
    seed: {
      category: { name: 'Mechanical wrist watches', glyph: '🕰️', defaultTrackingMode: 'SERIALISED' },
      fields: ordered([
        { name: 'Brand', fieldType: 'TEXT' },
        { name: 'Model', fieldType: 'TEXT' },
        { name: 'Movement', fieldType: 'SELECT', options: ['Automatic', 'Manual wind'] },
        { name: 'Calibre', fieldType: 'TEXT' },
        { name: 'Case material', fieldType: 'TEXT' },
        { name: 'Serial number', fieldType: 'TEXT' },
        {
          name: 'Condition',
          fieldType: 'SELECT',
          options: ['Mint', 'Near mint', 'Excellent', 'Very good', 'Good', 'Fair', 'Poor'],
        },
      ]),
    },
  },
  {
    id: 'military-surplus',
    sectionId: 'collectibles',
    name: 'Military surplus & medals',
    description: 'Militaria — item, nation, era and recipient.',
    seed: {
      category: { name: 'Military surplus & medals', glyph: '🎖️' },
      fields: ordered([
        { name: 'Item type', fieldType: 'TEXT' },
        { name: 'Nation / force', fieldType: 'TEXT' },
        { name: 'Conflict / era', fieldType: 'TEXT' },
        { name: 'Year', fieldType: 'NUMBER' },
        { name: 'Recipient / unit', fieldType: 'TEXT' },
        {
          name: 'Condition',
          fieldType: 'SELECT',
          options: ['Mint', 'Near mint', 'Excellent', 'Very good', 'Good', 'Fair', 'Poor'],
        },
      ]),
    },
  },
  {
    id: 'model-train',
    sectionId: 'collectibles',
    name: 'Model trains',
    description: 'Model railway — maker, gauge, road name and condition.',
    seed: {
      category: { name: 'Model trains', glyph: '🚂' },
      fields: ordered([
        { name: 'Manufacturer', fieldType: 'TEXT' },
        {
          name: 'Gauge / scale',
          fieldType: 'SELECT',
          options: ['N', 'TT', 'HO', 'OO', 'O', 'G', 'Other'],
        },
        { name: 'Road name', fieldType: 'TEXT' },
        { name: 'Catalogue number', fieldType: 'TEXT' },
        { name: 'Boxed', fieldType: 'ON_OFF' },
        {
          name: 'Condition',
          fieldType: 'SELECT',
          options: ['Mint boxed', 'Mint', 'Good', 'Weathered', 'Damaged'],
        },
      ]),
    },
  },
  {
    id: 'musical-instrument',
    sectionId: 'collectibles',
    name: 'Musical instruments',
    description: 'Instruments — type, brand, serial and condition.',
    seed: {
      category: { name: 'Musical instruments', glyph: '🎸', defaultTrackingMode: 'SERIALISED' },
      fields: ordered([
        { name: 'Type', fieldType: 'TEXT' },
        { name: 'Brand', fieldType: 'TEXT' },
        { name: 'Model', fieldType: 'TEXT' },
        { name: 'Serial number', fieldType: 'TEXT' },
        { name: 'Year', fieldType: 'NUMBER' },
        {
          name: 'Condition',
          fieldType: 'SELECT',
          options: ['Mint', 'Near mint', 'Excellent', 'Very good', 'Good', 'Fair', 'Poor'],
        },
      ]),
    },
  },
  {
    id: 'perfume-bottle',
    sectionId: 'collectibles',
    name: 'Perfume & fragrance bottles',
    description: 'Fragrances — brand, concentration, volume and fill.',
    seed: {
      category: { name: 'Perfume & fragrance bottles', glyph: '🌸' },
      fields: ordered([
        { name: 'Brand', fieldType: 'TEXT' },
        { name: 'Name', fieldType: 'TEXT' },
        {
          name: 'Concentration',
          fieldType: 'SELECT',
          options: ['Eau de Cologne', 'Eau de Toilette', 'Eau de Parfum', 'Parfum'],
        },
        { name: 'Volume (ml)', fieldType: 'NUMBER' },
        { name: 'Sealed', fieldType: 'ON_OFF' },
        {
          name: 'Fill level',
          fieldType: 'SELECT',
          options: ['Full', 'Over 75%', 'Over 50%', 'Over 25%', 'Under 25%'],
        },
      ]),
    },
  },
  {
    id: 'porcelain-ceramics',
    sectionId: 'collectibles',
    name: 'Porcelain & fine ceramics',
    description: 'Ceramics — factory, pattern, backstamp and condition.',
    seed: {
      category: { name: 'Porcelain & fine ceramics', glyph: '🏺' },
      fields: ordered([
        { name: 'Maker / factory', fieldType: 'TEXT' },
        { name: 'Pattern', fieldType: 'TEXT' },
        {
          name: 'Type',
          fieldType: 'SELECT',
          options: ['Plate', 'Bowl', 'Vase', 'Figurine', 'Cup & saucer', 'Teapot', 'Other'],
        },
        { name: 'Backstamp', fieldType: 'TEXT' },
        { name: 'Approx. year', fieldType: 'NUMBER' },
        {
          name: 'Condition',
          fieldType: 'SELECT',
          options: ['Mint', 'Excellent', 'Crazing', 'Chipped', 'Cracked', 'Restored'],
        },
      ]),
    },
  },
  {
    id: 'postcard',
    sectionId: 'collectibles',
    name: 'Postcards',
    description: 'Deltiology — subject, publisher, era and condition.',
    seed: {
      category: { name: 'Postcards', glyph: '📮' },
      fields: ordered([
        { name: 'Subject / place', fieldType: 'TEXT' },
        { name: 'Publisher', fieldType: 'TEXT' },
        {
          name: 'Era',
          fieldType: 'SELECT',
          options: ['Undivided back', 'Divided back', 'White border', 'Linen', 'Chrome', 'Modern'],
        },
        { name: 'Postally used', fieldType: 'ON_OFF' },
        {
          name: 'Condition',
          fieldType: 'SELECT',
          options: ['Mint', 'Near mint', 'Excellent', 'Very good', 'Good', 'Fair', 'Poor'],
        },
      ]),
    },
  },
  {
    id: 'arcade-pinball',
    sectionId: 'collectibles',
    name: 'Retro arcade & pinball machines',
    description: 'Coin-op machines — maker, title, type and working state.',
    seed: {
      category: { name: 'Retro arcade & pinball machines', glyph: '🕹️', defaultTrackingMode: 'SERIALISED' },
      fields: ordered([
        { name: 'Manufacturer', fieldType: 'TEXT' },
        { name: 'Title', fieldType: 'TEXT' },
        {
          name: 'Type',
          fieldType: 'SELECT',
          options: ['Upright arcade', 'Cocktail', 'Cabaret', 'Pinball', 'Cockpit'],
        },
        { name: 'Year', fieldType: 'NUMBER' },
        { name: 'Working', fieldType: 'ON_OFF' },
        {
          name: 'Condition',
          fieldType: 'SELECT',
          options: ['Mint', 'Near mint', 'Excellent', 'Very good', 'Good', 'Fair', 'Poor'],
        },
      ]),
    },
  },
  {
    id: 'retro-console',
    sectionId: 'collectibles',
    name: 'Retro gaming consoles & cartridges',
    description: 'Retro gaming — type, platform, region and condition.',
    seed: {
      category: { name: 'Retro gaming consoles & cartridges', glyph: '🎮' },
      fields: ordered([
        {
          name: 'Type',
          fieldType: 'SELECT',
          options: ['Console', 'Cartridge', 'Disc', 'Accessory', 'Handheld'],
        },
        { name: 'Platform', fieldType: 'TEXT' },
        { name: 'Title', fieldType: 'TEXT' },
        { name: 'Region', fieldType: 'SELECT', options: ['NTSC-U', 'NTSC-J', 'PAL'] },
        { name: 'Boxed', fieldType: 'ON_OFF' },
        {
          name: 'Condition',
          fieldType: 'SELECT',
          options: ['Sealed', 'Complete in box', 'Loose', 'Faulty'],
        },
      ]),
    },
  },
  {
    id: 'sneakers',
    sectionId: 'collectibles',
    name: 'Shoes / trainers / sneakers',
    description: 'Footwear — brand, colourway, size and condition.',
    seed: {
      category: { name: 'Shoes / trainers / sneakers', glyph: '👟' },
      fields: ordered([
        { name: 'Brand', fieldType: 'TEXT' },
        { name: 'Model', fieldType: 'TEXT' },
        { name: 'Colourway', fieldType: 'TEXT' },
        { name: 'Size', fieldType: 'TEXT' },
        { name: 'Deadstock', fieldType: 'ON_OFF' },
        { name: 'Boxed', fieldType: 'ON_OFF' },
        {
          name: 'Condition',
          fieldType: 'SELECT',
          options: ['Deadstock', 'Very near deadstock', 'Used - good', 'Used - worn'],
        },
      ]),
    },
  },
  {
    id: 'shot-glass',
    sectionId: 'collectibles',
    name: 'Shot glasses',
    description: 'Shot glasses — theme, material, design and condition.',
    seed: {
      category: { name: 'Shot glasses', glyph: '🥃' },
      fields: ordered([
        { name: 'Theme / origin', fieldType: 'TEXT' },
        {
          name: 'Material',
          fieldType: 'SELECT',
          options: ['Glass', 'Ceramic', 'Metal', 'Acrylic'],
        },
        { name: 'Design', fieldType: 'TEXT' },
        {
          name: 'Condition',
          fieldType: 'SELECT',
          options: ['Mint', 'Near mint', 'Excellent', 'Very good', 'Good', 'Fair', 'Poor'],
        },
      ]),
    },
  },
  {
    id: 'silver-flatware',
    sectionId: 'collectibles',
    name: 'Silverplate & sterling silver flatware',
    description: 'Silver flatware — maker, pattern, type and hallmark.',
    seed: {
      category: { name: 'Silverplate & sterling silver flatware', glyph: '🍴' },
      fields: ordered([
        { name: 'Maker', fieldType: 'TEXT' },
        { name: 'Pattern', fieldType: 'TEXT' },
        {
          name: 'Type',
          fieldType: 'SELECT',
          options: ['Sterling silver', 'Silverplate', 'EPNS', 'Coin silver'],
        },
        { name: 'Hallmark', fieldType: 'TEXT' },
        { name: 'Piece', fieldType: 'TEXT' },
        { name: 'Weight (g)', fieldType: 'NUMBER' },
      ]),
    },
  },
  {
    id: 'snow-globe',
    sectionId: 'collectibles',
    name: 'Snow globes',
    description: 'Snow globes — theme, maker, musical and condition.',
    seed: {
      category: { name: 'Snow globes', glyph: '❄️' },
      fields: ordered([
        { name: 'Theme / origin', fieldType: 'TEXT' },
        { name: 'Maker', fieldType: 'TEXT' },
        { name: 'Musical', fieldType: 'ON_OFF' },
        {
          name: 'Condition',
          fieldType: 'SELECT',
          options: ['Mint', 'Good', 'Cloudy water', 'Leaking', 'Damaged'],
        },
      ]),
    },
  },
  {
    id: 'stamp',
    sectionId: 'collectibles',
    name: 'Stamps',
    description: 'Philately — country, denomination, catalogue and grade.',
    seed: {
      category: { name: 'Stamps', glyph: '✉️' },
      fields: ordered([
        { name: 'Country', fieldType: 'TEXT' },
        { name: 'Year', fieldType: 'NUMBER' },
        { name: 'Denomination', fieldType: 'TEXT' },
        { name: 'Catalogue number', fieldType: 'TEXT' },
        {
          name: 'Condition',
          fieldType: 'SELECT',
          options: ['Mint never hinged', 'Mint hinged', 'Unused', 'Used', 'Fine used', 'Damaged'],
        },
        { name: 'Postmarked', fieldType: 'ON_OFF' },
      ]),
    },
  },
  {
    id: 'typewriter',
    sectionId: 'collectibles',
    name: 'Typewriters',
    description: 'Typewriters — maker, model, serial and working state.',
    seed: {
      category: { name: 'Typewriters', glyph: '⌨️', defaultTrackingMode: 'SERIALISED' },
      fields: ordered([
        { name: 'Manufacturer', fieldType: 'TEXT' },
        { name: 'Model', fieldType: 'TEXT' },
        { name: 'Serial number', fieldType: 'TEXT' },
        {
          name: 'Type',
          fieldType: 'SELECT',
          options: ['Manual', 'Electric', 'Portable', 'Standard'],
        },
        { name: 'Year', fieldType: 'NUMBER' },
        { name: 'Working', fieldType: 'ON_OFF' },
        {
          name: 'Condition',
          fieldType: 'SELECT',
          options: ['Mint', 'Near mint', 'Excellent', 'Very good', 'Good', 'Fair', 'Poor'],
        },
      ]),
    },
  },
  {
    id: 'video-game',
    sectionId: 'media',
    name: 'Video games (physical)',
    description: 'Physical games — platform, region and completeness.',
    seed: {
      category: { name: 'Video games (physical)', glyph: '👾' },
      fields: ordered([
        { name: 'Title', fieldType: 'TEXT' },
        { name: 'Platform', fieldType: 'TEXT' },
        { name: 'Publisher', fieldType: 'TEXT' },
        { name: 'Region', fieldType: 'SELECT', options: ['NTSC-U', 'NTSC-J', 'PAL'] },
        {
          name: 'Completeness',
          fieldType: 'SELECT',
          options: ['Sealed', 'Complete in box', 'Cart / disc only', 'Manual only'],
        },
        {
          name: 'Condition',
          fieldType: 'SELECT',
          options: ['Mint', 'Near mint', 'Excellent', 'Very good', 'Good', 'Fair', 'Poor'],
        },
      ]),
    },
  },
  {
    id: 'vintage-camera',
    sectionId: 'collectibles',
    name: 'Vintage cameras',
    description: 'Classic cameras — maker, type, format and working state.',
    seed: {
      category: { name: 'Vintage cameras', glyph: '📷', defaultTrackingMode: 'SERIALISED' },
      fields: ordered([
        { name: 'Manufacturer', fieldType: 'TEXT' },
        { name: 'Model', fieldType: 'TEXT' },
        {
          name: 'Type',
          fieldType: 'SELECT',
          options: ['SLR', 'Rangefinder', 'TLR', 'Point & shoot', 'Instant', 'Medium format', 'Large format'],
        },
        {
          name: 'Format',
          fieldType: 'SELECT',
          options: ['35mm', '120', '110', '126', 'APS', 'Sheet film', 'Digital'],
        },
        { name: 'Serial number', fieldType: 'TEXT' },
        { name: 'Working', fieldType: 'ON_OFF' },
      ]),
    },
  },
  {
    id: 'concert-tshirt',
    sectionId: 'collectibles',
    name: 'Vintage concert t-shirts',
    description: 'Band tees — artist, tour, year, size and condition.',
    seed: {
      category: { name: 'Vintage concert t-shirts', glyph: '🎽' },
      fields: ordered([
        { name: 'Artist / band', fieldType: 'TEXT' },
        { name: 'Tour', fieldType: 'TEXT' },
        { name: 'Year', fieldType: 'NUMBER' },
        { name: 'Size', fieldType: 'SELECT', options: ['XS', 'S', 'M', 'L', 'XL', 'XXL'] },
        { name: 'Single stitch', fieldType: 'ON_OFF' },
        {
          name: 'Condition',
          fieldType: 'SELECT',
          options: ['Mint', 'Near mint', 'Excellent', 'Very good', 'Good', 'Fair', 'Poor'],
        },
      ]),
    },
  },
  {
    id: 'vintage-kitchenware',
    sectionId: 'household',
    name: 'Vintage kitchenware',
    description: 'Retro kitchenware — maker, pattern, material and era.',
    seed: {
      category: { name: 'Vintage kitchenware', glyph: '🍳' },
      fields: ordered([
        { name: 'Maker', fieldType: 'TEXT' },
        { name: 'Pattern', fieldType: 'TEXT' },
        {
          name: 'Material',
          fieldType: 'SELECT',
          options: ['Pyrex glass', 'Enamel', 'Cast iron', 'Stoneware', 'Melamine', 'Stainless steel'],
        },
        { name: 'Approx. year', fieldType: 'NUMBER' },
        {
          name: 'Condition',
          fieldType: 'SELECT',
          options: ['Mint', 'Near mint', 'Excellent', 'Very good', 'Good', 'Fair', 'Poor'],
        },
      ]),
    },
  },
  {
    id: 'vintage-mirror',
    sectionId: 'collectibles',
    name: 'Vintage mirrors',
    description: 'Decorative mirrors — style, frame, shape and condition.',
    seed: {
      category: { name: 'Vintage mirrors', glyph: '🪞' },
      fields: ordered([
        { name: 'Style / period', fieldType: 'TEXT' },
        { name: 'Frame material', fieldType: 'TEXT' },
        {
          name: 'Shape',
          fieldType: 'SELECT',
          options: ['Rectangular', 'Round', 'Oval', 'Arched', 'Sunburst', 'Irregular'],
        },
        { name: 'Width (cm)', fieldType: 'NUMBER' },
        { name: 'Height (cm)', fieldType: 'NUMBER' },
        {
          name: 'Condition',
          fieldType: 'SELECT',
          options: ['Mint', 'Good', 'Foxing', 'Desilvering', 'Cracked'],
        },
      ]),
    },
  },
  {
    id: 'movie-poster',
    sectionId: 'media',
    name: 'Vintage movie posters',
    description: 'Film posters — title, format, originality and condition.',
    seed: {
      category: { name: 'Vintage movie posters', glyph: '🖼️' },
      fields: ordered([
        { name: 'Title', fieldType: 'TEXT' },
        { name: 'Year', fieldType: 'NUMBER' },
        {
          name: 'Format',
          fieldType: 'SELECT',
          options: ['One sheet', 'Half sheet', 'Insert', 'Lobby card', 'Quad', 'Three sheet'],
        },
        {
          name: 'Originality',
          fieldType: 'SELECT',
          options: ['Original', 'Reprint', 'Reproduction'],
        },
        { name: 'Rolled or folded', fieldType: 'SELECT', options: ['Rolled', 'Folded'] },
        {
          name: 'Condition',
          fieldType: 'SELECT',
          options: ['Mint', 'Near mint', 'Excellent', 'Very good', 'Good', 'Fair', 'Poor'],
        },
      ]),
    },
  },
  {
    id: 'quilt-textile',
    sectionId: 'collectibles',
    name: 'Vintage quilts & textiles',
    description: 'Textiles — type, pattern, material and condition.',
    seed: {
      category: { name: 'Vintage quilts & textiles', glyph: '🛏️' },
      fields: ordered([
        { name: 'Type', fieldType: 'TEXT' },
        { name: 'Pattern', fieldType: 'TEXT' },
        { name: 'Material', fieldType: 'TEXT' },
        { name: 'Approx. year', fieldType: 'NUMBER' },
        { name: 'Width (cm)', fieldType: 'NUMBER' },
        { name: 'Length (cm)', fieldType: 'NUMBER' },
        { name: 'Handmade', fieldType: 'ON_OFF' },
        {
          name: 'Condition',
          fieldType: 'SELECT',
          options: ['Mint', 'Near mint', 'Excellent', 'Very good', 'Good', 'Fair', 'Poor'],
        },
      ]),
    },
  },
  {
    id: 'wargaming-miniature',
    sectionId: 'collectibles',
    name: 'Warhammer & tabletop gaming miniatures',
    description: 'Miniatures — system, faction, scale and paint status.',
    seed: {
      category: { name: 'Warhammer & tabletop gaming miniatures', glyph: '⚔️' },
      fields: ordered([
        { name: 'Game system', fieldType: 'TEXT' },
        { name: 'Faction / army', fieldType: 'TEXT' },
        { name: 'Unit', fieldType: 'TEXT' },
        {
          name: 'Scale',
          fieldType: 'SELECT',
          options: ['28mm / Heroic', '32mm', '15mm', '6mm / Epic', 'Other'],
        },
        {
          name: 'Assembly',
          fieldType: 'SELECT',
          options: ['On sprue', 'Assembled', 'Primed', 'Painted'],
        },
        { name: 'Painted', fieldType: 'ON_OFF' },
      ]),
    },
  },
  {
    id: 'wine-spirits',
    sectionId: 'collectibles',
    name: 'Wine, whiskey & rare spirits',
    description: 'Fine drink — type, producer, vintage and ABV.',
    seed: {
      category: { name: 'Wine, whiskey & rare spirits', glyph: '🍷' },
      fields: ordered([
        {
          name: 'Type',
          fieldType: 'SELECT',
          options: ['Wine', 'Whisky', 'Whiskey', 'Brandy', 'Rum', 'Vodka', 'Gin', 'Other'],
        },
        { name: 'Producer', fieldType: 'TEXT' },
        { name: 'Vintage / age', fieldType: 'TEXT' },
        { name: 'Region', fieldType: 'TEXT' },
        { name: 'ABV (%)', fieldType: 'NUMBER' },
        { name: 'Volume (ml)', fieldType: 'NUMBER' },
        { name: 'Sealed', fieldType: 'ON_OFF' },
      ]),
    },
  },
  {
    id: 'wood-stock',
    sectionId: 'workshop',
    name: 'Wood stock',
    description: 'Timber and sheet stock — species, form and dimensions.',
    seed: {
      category: { name: 'Wood stock', glyph: '🪵' },
      fields: ordered([
        { name: 'Species', fieldType: 'TEXT' },
        {
          name: 'Form',
          fieldType: 'SELECT',
          options: ['Board', 'Plank', 'Sheet', 'Dowel', 'Turning blank', 'Veneer', 'Log'],
        },
        { name: 'Thickness (mm)', fieldType: 'NUMBER' },
        { name: 'Width (mm)', fieldType: 'NUMBER' },
        { name: 'Length (mm)', fieldType: 'NUMBER' },
        { name: 'Seasoned', fieldType: 'ON_OFF' },
      ]),
    },
  },
  {
    id: 'zippo-lighter',
    sectionId: 'collectibles',
    name: 'Zippo lighters',
    description: 'Lighters — design, date code, finish and working state.',
    seed: {
      category: { name: 'Zippo lighters', glyph: '🔥' },
      fields: ordered([
        { name: 'Model / design', fieldType: 'TEXT' },
        { name: 'Year / date code', fieldType: 'TEXT' },
        {
          name: 'Finish',
          fieldType: 'SELECT',
          options: ['Chrome', 'Brushed', 'Black matte', 'Brass', 'Painted', 'Engraved'],
        },
        { name: 'Boxed', fieldType: 'ON_OFF' },
        { name: 'Working', fieldType: 'ON_OFF' },
        {
          name: 'Condition',
          fieldType: 'SELECT',
          options: ['Mint', 'Near mint', 'Excellent', 'Very good', 'Good', 'Fair', 'Poor'],
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
