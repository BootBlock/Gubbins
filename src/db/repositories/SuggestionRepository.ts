/**
 * SuggestionRepository — distinct existing values for the auto-completing form fields
 * (Field auto-completion).
 *
 * A handful of free-text fields (manufacturer, supplier name, gauge unit, currency) are
 * entered over and over across the catalogue, so the Add/Edit forms offer type-ahead
 * suggestions. This repository supplies the *existing* half of that list — the distinct
 * values the user has already entered — which the feature layer merges with a seeded set
 * of popular defaults ({@link file://../../features/inventory/field-suggestions.ts}).
 *
 * Reads only; nothing here grows storage, so no Hard-Stop gate applies. All SQL lives over
 * the injected driver (§2.1.1); the `table`/`column` interpolated below come exclusively
 * from the {@link SUGGESTION_SOURCES} whitelist — never from caller input — so there is no
 * injection surface.
 */
import { DbError } from '../errors';
import { BaseRepository } from './base';

/** The form fields that offer value auto-completion. */
export type SuggestionField = 'manufacturer' | 'supplierName' | 'unitOfMeasure';

/**
 * Where each field's already-entered values live. A fixed whitelist: the only source of
 * the `table`/`column` names interpolated into the DISTINCT query, so the interpolation is
 * safe by construction (values are still bound as parameters everywhere else).
 */
const SUGGESTION_SOURCES: Record<SuggestionField, { readonly table: string; readonly column: string }> = {
  manufacturer: { table: 'items', column: 'manufacturer' },
  supplierName: { table: 'supplier_parts', column: 'supplier_name' },
  unitOfMeasure: { table: 'items', column: 'unit_of_measure' },
};

export class SuggestionRepository extends BaseRepository {
  /**
   * The distinct non-blank values already entered for `field`, case-insensitively sorted.
   * Empty/whitespace-only cells are excluded so a stray blank never becomes a suggestion.
   */
  async distinctValues(field: SuggestionField): Promise<string[]> {
    const source = SUGGESTION_SOURCES[field];
    if (!source) {
      throw new DbError('SQLITE_ERROR', `Unknown suggestion field "${field}".`);
    }
    const { table, column } = source;
    const rows = await this.driver.query<{ value: string }>(
      `SELECT DISTINCT ${column} AS value FROM ${table}
       WHERE ${column} IS NOT NULL AND TRIM(${column}) <> ''
       ORDER BY ${column} COLLATE NOCASE ASC;`,
    );
    return rows.map((r) => r.value);
  }
}
