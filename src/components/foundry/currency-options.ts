/**
 * Pure data & helpers behind the currency controls, kept out of the component file so the
 * component module exports only components (for fast-refresh), matching the same split as
 * {@link import('./autocomplete-filter')}. Both the select-only `CurrencySelect` and the
 * editable `CurrencyAutocompleteField` build on these.
 */
import { CURRENCY_OPTIONS } from '@/lib/format';
import { type SelectOption } from './select';

/** Popular currencies as `CODE — Name` rows, shared by both currency controls. */
export const CURRENCY_SUGGESTIONS = CURRENCY_OPTIONS.map((c) => `${c.value} — ${c.label}`);

/**
 * Default guidance shown in the editable field's `(i)` hint when a caller doesn't supply its
 * own. Tells the user what a valid value looks like — the point of the control — and that a
 * blank field falls back to the base currency.
 */
export const DEFAULT_CURRENCY_HINT =
  'Pick a currency from the list, or type its three-letter ISO 4217 code (e.g. `GBP`, `USD`, ' +
  '`EUR`). Leave it blank to use your base currency.';

/**
 * Reduce an accepted currency value to a bare, upper-cased ISO code: a chosen suggestion
 * `"EUR — Euro"` becomes `"EUR"`, and a free-typed `"eur"` becomes `"EUR"`. Exported so the
 * few call sites that manage their own state normalise identically.
 */
export function currencyCodeFromInput(value: string): string {
  return value.split(' — ')[0]!.trim().toUpperCase();
}

/**
 * Build the option list the select-only picker offers: the popular {@link CURRENCY_OPTIONS} as
 * `CODE — Name` rows. A non-empty `value` that isn't one of the offered codes is appended
 * verbatim so an existing off-list code still shows and round-trips rather than silently
 * blanking.
 */
export function buildCurrencyOptions(value: string): SelectOption[] {
  const options: SelectOption[] = CURRENCY_OPTIONS.map((c) => ({
    value: c.value,
    label: `${c.value} — ${c.label}`,
  }));
  if (value && !CURRENCY_OPTIONS.some((c) => c.value === value)) options.push({ value, label: value });
  return options;
}
