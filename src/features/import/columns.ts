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

/** A quantity written with a trailing unit, e.g. `"3 pcs"`, `"10 units"`. */
const LEADING_INTEGER_RE = /^(\d+)\b/;

/**
 * The leading whole integer of a unit-suffixed count (`"3 pcs"` → 3, `"10 units"` → 10), or
 * `null` when the cell does not begin with digits followed by a boundary. A unit written with
 * no separating space (`"2x"`) is *not* matched — the digits must end at a word boundary, so a
 * bare `2x` is left unreadable rather than guessed at.
 *
 * This is the shared suffix rule the whole-count readers sit on: {@link readCountCell} reads a
 * quantity column through it, and the item-catalogue importer preserves any fraction for its
 * schema to report (issue #391). Keeping the rule here means a suffixed count reads identically
 * through every importer rather than each re-deriving the fallback.
 */
export function leadingIntegerCount(raw: string): number | null {
  const suffixed = LEADING_INTEGER_RE.exec(raw.trim());
  return suffixed ? Number.parseInt(suffixed[1]!, 10) : null;
}

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
 * This and {@link readCountCell} are the numeric-cell rule for **every** importer — the
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
 * Why a source row the file described was not turned into an import line. Every reason is a
 * quantity the file **stated** but that cannot be honoured as written (issue #350) — never a
 * blank cell, which genuinely means "not supplied" and takes the importer's default.
 */
export type ImportRowProblemReason = 'zero' | 'negative' | 'fractional' | 'unreadable';

/**
 * A source row that was read but not imported, and why.
 *
 * Collected rather than thrown, the same way the item catalogue importer collects its row
 * errors: one unusable cell costs its own row rather than the whole file, and the importer's
 * preview lists what was left out. That listing is the entire point — a quantity replaced by a
 * default is indistinguishable from a blank cell, so a silently-substituted count is exactly
 * the failure this type exists to prevent.
 */
export interface ImportRowProblem {
  /** 1-based index of the source data row (the header row is not counted). */
  readonly sourceRow: number;
  /** What the row called itself, so the message names something the user can find in the file. */
  readonly label: string;
  readonly reason: ImportRowProblemReason;
  /** The offending cell exactly as the file wrote it. */
  readonly value: string;
}

/** How an importer wants a quantity cell read. */
export interface CountCellOptions {
  /** The count to use when the column is absent or the cell is blank. */
  readonly fallback: number;
  /**
   * Whether a literal `0` is a usable count for this importer. A BOM line may legitimately
   * require none of a part — "not needed this build" (`project_bom_lines.required_qty >= 0`) —
   * whereas an order line for zero units cannot exist at all
   * (`purchase_order_lines.ordered_qty > 0`), so the two importers answer this differently.
   */
  readonly zeroAllowed: boolean;
}

/** A quantity cell resolved to a whole count, or to the reason it cannot become one. */
export type CountCellResult =
  | { readonly ok: true; readonly value: number }
  | { readonly ok: false; readonly reason: ImportRowProblemReason; readonly value: string };

/**
 * Read a cell as a whole count (a quantity), reporting *why* rather than substituting a number
 * whenever the cell says something a count cannot express.
 *
 * Only an absent column or a blank cell takes `options.fallback`: that is the one case where
 * the user supplied nothing, so a default states no more than the file did. Everything else the
 * file actually wrote is reported — a deliberate `0`, a negative, a fraction, or text that is
 * not a number at all — because substituting a default there would silently import a quantity
 * the file never asked for (issue #350).
 *
 * A grouped or spreadsheet-formatted integer (`"1,000"`, `"2.0"`) reads as that integer; a
 * figure with a trailing unit (`"3 pcs"`) keeps its leading integer, which is what a
 * hand-written parts list means — the one place a count is read more loosely than an amount.
 */
export function readCountCell(
  row: readonly string[],
  index: number | undefined,
  options: CountCellOptions,
): CountCellResult {
  const raw = cellAt(row, index);
  if (raw === null) return { ok: true, value: options.fallback };

  // A unit suffix ("3 pcs") defeats the amount reader, so fall back to the leading integer.
  const parsed = parseAmountCell(raw) ?? leadingIntegerCount(raw);
  if (parsed === null || !Number.isFinite(parsed)) return { ok: false, reason: 'unreadable', value: raw };
  if (!Number.isInteger(parsed)) return { ok: false, reason: 'fractional', value: raw };
  if (parsed < 0) return { ok: false, reason: 'negative', value: raw };
  if (parsed === 0 && !options.zeroAllowed) return { ok: false, reason: 'zero', value: raw };
  return { ok: true, value: parsed };
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
