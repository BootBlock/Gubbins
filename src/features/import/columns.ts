/**
 * Shared column-mapping layer for tabular imports.
 *
 * {@link module:features/import/tabular} turns arbitrary input into a header + data-row
 * matrix; this module turns that *header* into a map of **logical column → cell index**, and
 * reads individual cells back out as trimmed text, counts or amounts. Every importer needs
 * the same three things — forgiving header matching, blank-aware cell reads, and numeric
 * coercion — so they live here once rather than being re-implemented per importer (the BOM
 * importer and the purchase-list importer both sit on this).
 *
 * Kept pure (no React, no DOM, no DB) like the extraction engine below it, so the whole
 * module unit-tests instantly under Node.
 */
import { parseMoneyNumber } from '@/features/inventory/ocr/receipt-ocr';

/**
 * Normalise a header cell to a comparison key: lower-cased, with everything that is not a
 * letter or digit removed. This is what makes header matching forgiving — `"Unit Cost"`,
 * `"unit_cost"` and `"UNIT-COST"` all reduce to `unitcost`, so a synonym list only ever has
 * to spell each name one way.
 */
export function headerKey(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * The synonym table for one importer: each logical column mapped to the header keys that
 * mean it. Every synonym must already be in {@link headerKey} form (lower-case alphanumeric)
 * — {@link mapColumns} normalises the *input* header, not the table.
 */
export type ColumnSynonyms<K extends string> = Readonly<Record<K, readonly string[]>>;

/** A resolved header: logical column → the index of the cell holding it. */
export type ColumnMap<K extends string> = Partial<Record<K, number>>;

/**
 * Resolve a header row into a {@link ColumnMap} using the given synonym table. The **first**
 * matching cell wins for each logical column, so a duplicated header (a sheet with two
 * "Price" columns) binds to the leftmost rather than the last. Columns whose synonyms match
 * nothing are simply absent from the map — callers decide which are mandatory.
 */
export function mapColumns<K extends string>(
  header: readonly string[],
  synonyms: ColumnSynonyms<K>,
): ColumnMap<K> {
  const map: ColumnMap<K> = {};
  const entries = Object.entries(synonyms) as [K, readonly string[]][];
  header.forEach((cell, index) => {
    const key = headerKey(cell);
    for (const [logical, names] of entries) {
      if (map[logical] === undefined && names.includes(key)) {
        map[logical] = index;
      }
    }
  });
  return map;
}

/**
 * Read one cell as trimmed text, or `null` when the column is absent from the map, the row is
 * short, or the cell is blank. Collapsing "missing", "short row" and "whitespace only" to the
 * same `null` is deliberate: to an importer they all mean "the user did not supply this".
 */
export function cellAt(row: readonly string[], index: number | undefined): string | null {
  if (index === undefined) return null;
  const value = (row[index] ?? '').trim();
  return value.length > 0 ? value : null;
}

/** A quantity written with a trailing unit, e.g. `"3 pcs"`, `"10 units"`, `"2x"`. */
const LEADING_INTEGER_RE = /^(\d+)\b/;

/** A number in exponent form (`1e3`, `-2.5E-4`), which the money heuristic does not read. */
const EXPONENT_NUMBER = /^[+-]?(\d+(\.\d*)?|\.\d+)e[+-]?\d+$/i;

/**
 * Parse cell **text** as a monetary or measured amount, or `null` when it isn't a number.
 *
 * Currency symbols and both decimal conventions (`"£1,234.56"`, `"1.234,56"`, `"1,50"`) are
 * resolved by the shared {@link parseMoneyNumber} receipt heuristic — the same one the OCR
 * prefill uses. Space-class thousands separators (`"1 500"`, including the non-breaking and
 * narrow-no-break spaces a spreadsheet emits) fall out of that heuristic's whitespace
 * stripping; an explicit `+` sign and exponent notation are handled here, since a number is a
 * number however the exporting tool chose to write it.
 *
 * This and {@link parseCountCell} are the numeric-cell rule for **every** importer — the
 * `(row, index)` readers below are thin wrappers, and the item-catalogue importer parses its
 * cells through them too, so one importer cannot read numbers by a different rule to another
 * (issue #340).
 */
export function parseAmountCell(raw: string): number | null {
  const signed = raw.trim().replace(/^\+/, '');
  if (EXPONENT_NUMBER.test(signed)) return Number(signed);
  return parseMoneyNumber(signed);
}

/**
 * Parse cell **text** as a whole count, or `null` when it isn't a number at all.
 *
 * A decimal or grouped figure (`"1,000"`, `"2.0"`) is read as an amount and rounded, because
 * spreadsheets routinely format an integer quantity that way. A figure written with a trailing
 * unit (`"3 pcs"`) keeps its leading integer, which is what a hand-written parts list means —
 * the one place a count is read more loosely than an amount, where an amount would rather
 * report `"1.5 kg"` than silently drop its fraction.
 */
export function parseCountCell(raw: string): number | null {
  // A unit suffix ("3 pcs") defeats the amount reader, so fall back to the leading integer.
  const suffixed = LEADING_INTEGER_RE.exec(raw.trim());
  const parsed = parseAmountCell(raw) ?? (suffixed ? Number.parseInt(suffixed[1]!, 10) : null);
  return parsed === null ? null : Math.round(parsed);
}

/**
 * Read a cell as a positive whole count (a quantity), falling back to `fallback` when the
 * column is absent, blank or not a positive number. A zero or negative count is treated as
 * unusable and takes the fallback rather than producing a line the database's `ordered_qty > 0`
 * check would reject. The parsing rule itself is {@link parseCountCell}.
 */
export function cellAsCount(row: readonly string[], index: number | undefined, fallback: number): number {
  const raw = cellAt(row, index);
  if (raw === null) return fallback;
  const parsed = parseCountCell(raw);
  if (parsed === null) return fallback;
  return parsed > 0 ? parsed : fallback;
}

/**
 * Read a cell as a non-negative monetary amount, or `null` when absent, blank, unparseable or
 * negative. The parsing rule itself is {@link parseAmountCell}.
 */
export function cellAsAmount(row: readonly string[], index: number | undefined): number | null {
  const raw = cellAt(row, index);
  if (raw === null) return null;
  const parsed = parseAmountCell(raw);
  return parsed !== null && parsed >= 0 ? parsed : null;
}
