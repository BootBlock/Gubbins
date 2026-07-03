/**
 * Field auto-completion — pure seam (presets + merge).
 *
 * A handful of free-text form fields are entered over and over across the catalogue, so
 * the Add/Edit forms offer type-ahead suggestions rather than making the user retype (and
 * risk mis-spelling) `Texas Instruments` for the hundredth time. The suggestion list for a
 * field is the union of two sources:
 *
 *  1. **Existing values** — the distinct values the user has already entered, from
 *     {@link SuggestionRepository.distinctValues}. This is the authoritative half: it keeps
 *     spelling/casing consistent with the user's own catalogue.
 *  2. **Seeded presets** — a grounded list of popular defaults ({@link PRESET_SUGGESTIONS})
 *     so a brand-new, empty database still auto-completes the obvious names from day one.
 *
 * {@link mergeSuggestions} unions the two, de-duplicating case-insensitively with the user's
 * own spelling winning any clash, so the list never shows both `onsemi` and `Onsemi`. The
 * value the user types is always free — a suggestion is a shortcut, never a constraint.
 */
import type { SuggestionField } from '@/db/repositories';

/**
 * Seeded popular defaults per field, so an empty catalogue still auto-completes the obvious
 * values. Grounded against the major electronics component makers and distributors (the app
 * skews toward electronics inventory), plus the common gauge units. These are *starting
 * suggestions* only — never a whitelist — and the user's own entered values always take
 * precedence when the two overlap. (Currency has its own richer picker driven by
 * `CURRENCY_OPTIONS`, so it is deliberately not duplicated here.)
 */
export const PRESET_SUGGESTIONS: Record<SuggestionField, readonly string[]> = {
  // Component makers a maker/engineer actually stocks: semiconductors, passives, connectors
  // and the popular maker-board brands. Not a market-cap ranking — a "what's in the drawer".
  manufacturer: [
    'Texas Instruments',
    'STMicroelectronics',
    'Microchip Technology',
    'Analog Devices',
    'NXP Semiconductors',
    'Infineon Technologies',
    'onsemi',
    'Nexperia',
    'Renesas Electronics',
    'Diodes Incorporated',
    'ROHM Semiconductor',
    'Toshiba',
    'Broadcom',
    'Espressif Systems',
    'Nordic Semiconductor',
    'Raspberry Pi',
    'Arduino',
    'Adafruit',
    'SparkFun',
    'Vishay',
    'Yageo',
    'Murata',
    'TDK',
    'KEMET',
    'Bourns',
    'Panasonic',
    'Nichicon',
    'Würth Elektronik',
    'TE Connectivity',
    'Molex',
    'Amphenol',
    'JST',
    'Littelfuse',
    'Samsung',
  ],
  // The major global distributors, plus the maker-friendly and marketplace sources.
  supplierName: [
    'DigiKey',
    'Mouser',
    'Farnell',
    'Newark',
    'RS Components',
    'element14',
    'Arrow Electronics',
    'Avnet',
    'LCSC',
    'TME',
    'Reichelt',
    'Rapid Electronics',
    'CPC',
    'Adafruit',
    'SparkFun',
    'Pimoroni',
    'The Pi Hut',
    'JLCPCB',
    'AliExpress',
    'Amazon',
    'eBay',
  ],
  // Gauge consumables are measured, not counted — weight, volume and length units.
  unitOfMeasure: ['g', 'kg', 'mg', 'ml', 'l', 'm', 'cm', 'mm', 'oz', 'lb', 'ft', 'in'],
};

/**
 * Union the user's own entered values with the seeded presets, de-duplicated
 * case-insensitively (the user's spelling/casing wins any clash) and sorted A→Z so the list
 * reads predictably. Blank/whitespace-only entries are dropped defensively.
 */
export function mergeSuggestions(existing: readonly string[], presets: readonly string[]): string[] {
  const byKey = new Map<string, string>();
  // Presets first, so a user value with different casing overwrites the preset's casing.
  for (const raw of [...presets, ...existing]) {
    const value = raw.trim();
    if (value.length === 0) continue;
    byKey.set(value.toLowerCase(), value);
  }
  return [...byKey.values()].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
}
