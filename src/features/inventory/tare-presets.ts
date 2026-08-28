/**
 * Tare presets (issue #94) — a reusable library of "what does this container weigh empty",
 * so a tare is *picked* rather than typed from memory every time.
 *
 * Tare is already a first-class concept in Gubbins; this adds no new one. It feeds the two
 * places a tare is entered:
 *
 * - a `CONSUMABLE_GAUGE` item's `tareWeight` — the empty spool/jar the gauge's contents sit
 *   in, which is what turns a reading off a scale into "how much material is left";
 * - the per-reading tare of a weigh-in / count-by-weight.
 *
 * Every weight here is canonical **grams**, exactly like `items.weight` and the weigh-count
 * seam, so the maths never sees a display unit — the caller converts at the edge.
 *
 * ## Why the built-ins are approximate, and say so
 *
 * A tare is a *physical measurement of a specific object*, and manufacturers change spool
 * designs between production runs without renaming the product. The corroborating sources
 * below disagree by more than 100 g for the same brand: eSUN spools appear at 153 g
 * (cardboard) through 266 g (plastic), Sunlu at 130–200 g across generations, Polymaker
 * PolyTerra at ~137 g in cardboard against ~187 g in plastic. That spread is real, not
 * noise in the data.
 *
 * So these entries are a **starting point that must be verified on the user's own scale**,
 * never an authority. That is not a disclaimer bolted on afterwards — it shapes the design:
 *
 * - entries are keyed by brand *and variant* (material, generation, size), because a
 *   brand-only preset would be confidently wrong for half the spools sold under that name;
 * - each carries a {@link TarePreset.note} saying what was measured;
 * - the picker shows the "check this on your scale" caveat next to the value, and saving
 *   your own measured container is a first-class action beside picking a built-in.
 *
 * A container the user weighed themselves is always right; a published figure never quite
 * is. The built-ins exist to save typing on day one, not to replace the scale.
 *
 * ## Sources
 *
 * Figures are cross-checked across independent community measurement sets rather than taken
 * from any single list, and rounded to the nearest 5 g to avoid implying a precision the
 * underlying measurements do not have:
 *
 * - MatterHackers' empty-spool knowledge-base table;
 * - the community empty-spool weight database at emptyspool.github.io (itself compiled from
 *   a 3D-printing Stack Exchange table);
 * - independent teardown/measurement write-ups for individual brands.
 *
 * No third-party data file is vendored: these are individually-chosen, corroborated figures,
 * written here as plain facts about publicly-sold products.
 */
import { includesAllTerms, splitSearchTerms } from '@/lib/text-terms';
import { trimMeasureNoise } from '@/lib/measurement-format';
import { WEIGHT_UNITS, fromGrams, type WeightUnit } from '@/lib/weight';

/**
 * What kind of container a preset describes. Used to group the picker so a filament user
 * is not scrolling past flour jars — it carries no behaviour, and `OTHER` is always valid.
 */
export const TARE_PRESET_KINDS = ['SPOOL', 'JAR', 'BIN', 'TRAY', 'OTHER'] as const;

/** One of the container kinds a preset may be filed under. */
export type TarePresetKind = (typeof TARE_PRESET_KINDS)[number];

/** Coerce an arbitrary persisted value to a valid {@link TarePresetKind} (default `OTHER`). */
export function normaliseTarePresetKind(value: string | null | undefined): TarePresetKind {
  return (TARE_PRESET_KINDS as readonly string[]).includes(value ?? '') ? (value as TarePresetKind) : 'OTHER';
}

/** A container whose empty weight can be pulled into a tare field. */
export interface TarePreset {
  /** Stable slug for a built-in, or the row id for one the user saved. */
  readonly id: string;
  /** The container's name, e.g. `PolyTerra PLA 1 kg (cardboard)`. */
  readonly name: string;
  /** The maker, where the container is bought by brand. Absent for generic archetypes. */
  readonly brand?: string;
  /** Which group the picker files it under. */
  readonly kind: TarePresetKind;
  /** The empty weight in canonical **grams**. */
  readonly tareGrams: number;
  /** What was measured, or how much the figure varies — shown under the name. */
  readonly note?: string;
  /** `true` for a container the user measured and saved themselves. */
  readonly saved?: boolean;
}

/**
 * The built-in catalogue. Ordered brand-alphabetically within each kind, which is the order
 * the picker shows. Read the module header before changing a number: these are corroborated
 * measurements, not preferences, and a figure with no source behind it is worse than absent.
 */
export const BUILT_IN_TARE_PRESETS: readonly TarePreset[] = [
  // --- Filament spools: generic archetypes -----------------------------------------
  // Listed first because they are the honest answer for an unbranded or unlisted spool:
  // the mainstream 1 kg band really does cluster this tightly across every brand measured.
  {
    id: 'spool-generic-plastic-1kg',
    name: 'Plastic spool, 1 kg (typical)',
    kind: 'SPOOL',
    tareGrams: 220,
    note: 'Most mainstream 1 kg plastic spools fall between 190 g and 250 g.',
  },
  {
    id: 'spool-generic-cardboard-1kg',
    name: 'Cardboard spool, 1 kg (typical)',
    kind: 'SPOOL',
    tareGrams: 160,
    note: 'Cardboard spools run lighter than plastic — roughly 140 g to 190 g.',
  },
  {
    id: 'spool-generic-masterspool',
    name: 'Reusable master spool',
    kind: 'SPOOL',
    tareGrams: 200,
    note: 'A refill spool holder kept between refills; weigh yours once and save it.',
  },

  // --- Filament spools: by brand and variant ---------------------------------------
  {
    id: 'spool-bambu-1kg',
    name: '1 kg spool (plastic, with cardboard core)',
    brand: 'Bambu Lab',
    kind: 'SPOOL',
    tareGrams: 250,
    note: 'Plastic sides plus the cardboard centre ring; the sides alone are around 210 g.',
  },
  {
    id: 'spool-creality-cardboard-1kg',
    name: 'Hyper series 1 kg (cardboard)',
    brand: 'Creality',
    kind: 'SPOOL',
    tareGrams: 175,
    note: 'Cardboard spool. Older Creality plastic spools measure nearer 140 g.',
  },
  {
    id: 'spool-elegoo-cardboard-1kg',
    name: '1 kg spool (cardboard)',
    brand: 'Elegoo',
    kind: 'SPOOL',
    tareGrams: 170,
    note: 'Cardboard spool; recent PETG runs measure closer to 155 g.',
  },
  {
    id: 'spool-esun-plastic-1kg',
    name: '1 kg spool (plastic)',
    brand: 'eSUN',
    kind: 'SPOOL',
    tareGrams: 240,
    note: 'Averaged across ten empty spools; individual runs range 214 g to 266 g.',
  },
  {
    id: 'spool-esun-cardboard-1kg',
    name: '1 kg spool (cardboard)',
    brand: 'eSUN',
    kind: 'SPOOL',
    tareGrams: 155,
    note: 'The cardboard alternative to the plastic spool above.',
  },
  {
    id: 'spool-hatchbox-1kg',
    name: '1 kg spool (plastic)',
    brand: 'Hatchbox',
    kind: 'SPOOL',
    tareGrams: 230,
    note: 'Older stock measures nearer 224 g, more recent spools nearer 245 g.',
  },
  {
    id: 'spool-inland-1kg',
    name: '1 kg spool (plastic)',
    brand: 'Inland',
    kind: 'SPOOL',
    tareGrams: 220,
    note: 'Also sold as the Micro Center house brand. The 500 g spool is around 195 g.',
  },
  {
    id: 'spool-overture-plastic-1kg',
    name: '1 kg spool (plastic)',
    brand: 'Overture',
    kind: 'SPOOL',
    tareGrams: 240,
    note: 'The earlier plastic spool; a later revision measures nearer 185 g.',
  },
  {
    id: 'spool-overture-cardboard-1kg',
    name: '1 kg spool (cardboard)',
    brand: 'Overture',
    kind: 'SPOOL',
    tareGrams: 175,
    note: 'Cardboard spool.',
  },
  {
    id: 'spool-polymaker-polyterra-1kg',
    name: 'PolyTerra PLA 1 kg (cardboard)',
    brand: 'Polymaker',
    kind: 'SPOOL',
    tareGrams: 140,
    note: 'Cardboard spool; Polymaker print a weight on the spool itself — prefer that.',
  },
  {
    id: 'spool-polymaker-plastic-1kg',
    name: '1 kg spool (plastic)',
    brand: 'Polymaker',
    kind: 'SPOOL',
    tareGrams: 190,
    note: 'The plastic spool used across most non-PolyTerra lines.',
  },
  {
    id: 'spool-prusament-1kg',
    name: 'Prusament 1 kg spool',
    brand: 'Prusa',
    kind: 'SPOOL',
    tareGrams: 200,
    note: 'Commonly quoted as 200 g; measured samples land nearer 193 g when dry. Each spool has an ID that gives its exact weight.',
  },
  {
    id: 'spool-prusament-mini',
    name: 'Prusament 300 g mini spool',
    brand: 'Prusa',
    kind: 'SPOOL',
    tareGrams: 130,
  },
  {
    id: 'spool-sunlu-1kg',
    name: '1 kg spool (plastic)',
    brand: 'Sunlu',
    kind: 'SPOOL',
    tareGrams: 140,
    note: 'Varies noticeably by generation, from about 130 g to 155 g.',
  },

  // --- Kitchen and storage containers -----------------------------------------------
  // Deliberately generic and few: unlike spools, jars and tubs are not sold to a published
  // empty weight, and the household containers a user actually owns are far too varied to
  // catalogue. These are rough starting points — the real answer is to weigh yours and
  // save it, which is exactly what the picker offers alongside these.
  {
    id: 'jar-mason-pint',
    name: 'Mason jar, 1 pint / 500 ml (with lid)',
    kind: 'JAR',
    tareGrams: 260,
    note: 'Glass jars vary a lot by maker — anywhere from 235 g to 285 g with the lid and band.',
  },
  {
    id: 'jar-mason-quart',
    name: 'Mason jar, 1 quart / 1 litre (with lid)',
    kind: 'JAR',
    tareGrams: 400,
    note: 'Approximate. Weigh yours once for anything you measure often.',
  },
  {
    id: 'tray-generic-small',
    name: 'Small parts tray',
    kind: 'TRAY',
    tareGrams: 40,
    note: 'A light plastic sorting tray; weigh yours to be sure.',
  },
];

/**
 * Search the presets by free text. Matches on name, brand and kind together so that both
 * "polymaker cardboard" and "spool cardboard" narrow to the same handful, using the shared
 * term-AND-substring matcher rather than a per-picker copy.
 */
export function searchTarePresets(presets: readonly TarePreset[], query: string): readonly TarePreset[] {
  const terms = splitSearchTerms(query);
  if (terms.length === 0) return presets;
  // The note is deliberately NOT searched: several notes mention a *contrasting* material
  // ("plastic sides plus the cardboard centre ring"), so including them would surface a
  // plastic spool under a "cardboard" filter — the opposite of what was asked for.
  return presets.filter((preset) =>
    includesAllTerms([preset.name, preset.brand ?? '', preset.kind].join(' '), terms),
  );
}

/**
 * The label a preset shows in a list: the brand and name read as one phrase where a brand
 * is present, so `Polymaker` + `PolyTerra PLA 1 kg (cardboard)` reads as a single product
 * rather than two competing titles.
 */
export function tarePresetLabel(preset: TarePreset): string {
  return preset.brand ? `${preset.brand} ${preset.name}` : preset.name;
}

/**
 * Group presets by kind, preserving declared order within each group and dropping kinds
 * with no entries. The picker renders these as headed sections.
 */
export function groupTarePresetsByKind(
  presets: readonly TarePreset[],
): readonly { kind: TarePresetKind; presets: readonly TarePreset[] }[] {
  return TARE_PRESET_KINDS.map((kind) => ({
    kind,
    presets: presets.filter((preset) => preset.kind === kind),
  })).filter((group) => group.presets.length > 0);
}

/**
 * Render a canonical gram weight as the *text* a weight field should hold, in `unit`.
 *
 * Delegates to {@link trimMeasureNoise}, the same trim the item editor's own weight and dimension
 * fields use, so every field a preset or a scale reading can fill puts the *same* text in the box
 * rather than each rounding slightly differently. That shared rule is magnitude-aware for a
 * reason: a flat four-decimal round is finer than any scale's resolution in grams, but it is
 * 0.635 g in **stones**, which would quantise a small tare on its way into the field and erase
 * one under 0.32 g outright.
 */
export function tareFieldValue(grams: number, unit: WeightUnit): string {
  return trimMeasureNoise(fromGrams(grams, unit));
}

/**
 * Weight symbols a gauge's **free-text** `unitOfMeasure` may not claim, because the same two
 * letters are written far more often for something else: `gr` for a gram (a grain is 1/15th of
 * one), and `ct` for a count. A gauge is labelled by hand, so a symbol that is *probably* not
 * the mass unit it matches has to be refused — offering a gram preset against a gauge counted
 * in `ct` would write a plausible-looking number that is out by a factor of five. The
 * free-form paste importer refuses the same two words for the same reason.
 *
 * Typed as {@link WeightUnit}s so a symbol retired from the unit list cannot linger here.
 */
const AMBIGUOUS_GAUGE_UNITS = ['gr', 'ct'] as const satisfies readonly WeightUnit[];

/**
 * The weight unit a gauge's tare is expressed in, or `null` when the gauge is not measured
 * by mass at all.
 *
 * A `CONSUMABLE_GAUGE`'s tare is carried in the gauge's *own* `unitOfMeasure`, which is free
 * text and frequently isn't a mass: a cable reel is measured in `m`, a tank in `ml`. A tare
 * preset is a mass in grams, so offering one against a gauge measured in metres would write a
 * number that means nothing — the picker is hidden entirely in that case rather than filling
 * the field with a plausible-looking wrong value.
 *
 * Matching is trimmed and case-insensitive so `G` / `Kg` resolve like `g` / `kg`, and it skips
 * {@link AMBIGUOUS_GAUGE_UNITS} — reading one of those the wrong way is the very failure this
 * function exists to prevent.
 */
export function gaugeTareWeightUnit(unitOfMeasure: string | null | undefined): WeightUnit | null {
  const unit = (unitOfMeasure ?? '').trim().toLowerCase();
  if ((AMBIGUOUS_GAUGE_UNITS as readonly string[]).includes(unit)) return null;
  return (WEIGHT_UNITS as readonly string[]).includes(unit) ? (unit as WeightUnit) : null;
}

// --- Saving a container of your own -------------------------------------------------

/** Trim a preset name to its stored form; `null` when nothing is left (a blank name). */
export function normaliseTarePresetName(name: string | null | undefined): string | null {
  const trimmed = (name ?? '').trim();
  return trimmed === '' ? null : trimmed;
}

/** Trim an optional free-text field (brand, note) to its stored form; blank becomes `null`. */
export function normaliseTarePresetText(value: string | null | undefined): string | null {
  const trimmed = (value ?? '').trim();
  return trimmed === '' ? null : trimmed;
}

/**
 * Coerce an entered tare to its stored form. Returns `undefined` (not `null`) for a value that
 * cannot be stored — non-finite or negative — so the caller can distinguish "rejected" from a
 * legitimately stored zero, exactly as the wishlist seam distinguishes a cleared price.
 */
export function normaliseTareGrams(grams: number | null | undefined): number | undefined {
  if (grams === null || grams === undefined) return undefined;
  if (!Number.isFinite(grams) || grams < 0) return undefined;
  return grams;
}

/** Why {@link planTarePreset} rejected an entry. */
export type TarePresetPlanError = 'EMPTY_NAME' | 'INVALID_TARE';

/** A validated, normalised preset ready to store. */
export interface PlannedTarePreset {
  readonly name: string;
  readonly brand: string | null;
  readonly kind: TarePresetKind;
  readonly tareGrams: number;
  readonly note: string | null;
}

/**
 * Validate and normalise a container the user is saving. Pure, so the rules — and in
 * particular *which* field is blamed — are unit-tested rather than buried in the repository.
 */
export function planTarePreset(input: {
  readonly name: string;
  readonly brand?: string | null;
  readonly kind?: string | null;
  readonly tareGrams: number;
  readonly note?: string | null;
}): { ok: true; preset: PlannedTarePreset } | { ok: false; reason: TarePresetPlanError } {
  const name = normaliseTarePresetName(input.name);
  if (name === null) return { ok: false, reason: 'EMPTY_NAME' };

  const tareGrams = normaliseTareGrams(input.tareGrams);
  if (tareGrams === undefined) return { ok: false, reason: 'INVALID_TARE' };

  return {
    ok: true,
    preset: {
      name,
      brand: normaliseTarePresetText(input.brand),
      kind: normaliseTarePresetKind(input.kind),
      tareGrams,
      note: normaliseTarePresetText(input.note),
    },
  };
}
