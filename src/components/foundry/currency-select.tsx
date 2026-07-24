import { type ReactNode, type Ref, useMemo } from 'react';
import { CURRENCY_OPTIONS } from '@/lib/format';
import { AutocompleteField } from './autocomplete';
import { Select, type SelectOption } from './select';

/** Popular currencies as `CODE — Name` rows, shared by both currency controls below. */
const CURRENCY_SUGGESTIONS = CURRENCY_OPTIONS.map((c) => `${c.value} — ${c.label}`);

/**
 * Default guidance shown in the editable field's `(i)` hint when a caller doesn't supply its
 * own. Tells the user what a valid value looks like — the request behind this control — and
 * that blank falls back to the base currency.
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
function buildCurrencyOptions(value: string): SelectOption[] {
  const options: SelectOption[] = CURRENCY_OPTIONS.map((c) => ({
    value: c.value,
    label: `${c.value} — ${c.label}`,
  }));
  if (value && !CURRENCY_OPTIONS.some((c) => c.value === value)) options.push({ value, label: value });
  return options;
}

export interface CurrencySelectProps {
  /** The current ISO-4217 code. */
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly className?: string;
  readonly disabled?: boolean;
  readonly placeholder?: string;
  readonly 'aria-label'?: string;
  readonly 'aria-labelledby'?: string;
  readonly 'aria-describedby'?: string;
  readonly 'aria-invalid'?: boolean;
  readonly 'data-testid'?: string;
}

/**
 * Foundry CurrencySelect — a **select-only** currency picker (one of the offered codes),
 * wrapping the Foundry {@link Select} pre-loaded with {@link CURRENCY_OPTIONS}. This is the
 * control for a **required** currency that must be a valid `Intl` code — namely the base
 * currency, which drives every money format app-wide and would break formatting if it were an
 * arbitrary string. For the *optional, per-record* currency fields, where the user may need a
 * currency outside the popular list, use {@link CurrencyAutocompleteField} instead.
 *
 * Name it with `aria-label`/`aria-labelledby` (a `role="combobox"` element can't be named by a
 * wrapping `<label>`).
 */
export function CurrencySelect({
  value,
  onChange,
  className,
  disabled,
  placeholder,
  'aria-label': ariaLabel,
  'aria-labelledby': ariaLabelledBy,
  'aria-describedby': ariaDescribedBy,
  'aria-invalid': ariaInvalid,
  'data-testid': testId,
}: CurrencySelectProps) {
  const options = useMemo(() => buildCurrencyOptions(value), [value]);
  return (
    <Select
      value={value}
      onChange={onChange}
      options={options}
      className={className}
      disabled={disabled}
      placeholder={placeholder}
      aria-label={ariaLabel}
      aria-labelledby={ariaLabelledBy}
      aria-describedby={ariaDescribedBy}
      aria-invalid={ariaInvalid}
      data-testid={testId}
    />
  );
}

export interface CurrencyAutocompleteFieldProps {
  readonly label: ReactNode;
  /** The current ISO-4217 code, or `''` to fall back to the base currency. */
  readonly value: string;
  readonly onChange: (value: string) => void;
  /** Validation message; when present the control is marked invalid and this is announced. */
  readonly error?: string;
  /**
   * `(i)` help content (Markdown); defaults to {@link DEFAULT_CURRENCY_HINT}. Pass a richer,
   * context-specific hint where the field carries extra meaning (e.g. how a non-base currency
   * affects valuation totals).
   */
  readonly hint?: string;
  readonly className?: string;
  readonly placeholder?: string;
  readonly disabled?: boolean;
  readonly inputRef?: Ref<HTMLInputElement>;
  readonly 'data-testid'?: string;
}

/**
 * Foundry CurrencyAutocompleteField — the **editable** currency control: a real free-text
 * field that *also* offers the popular {@link CURRENCY_OPTIONS} as a filtered dropdown, built
 * on the Foundry {@link AutocompleteField}. It suits the optional, per-record currency fields
 * (a supplier's default, a supplier part's or a purchase order's currency), where the user
 * usually wants one of the common currencies but must be able to enter any ISO-4217 code — a
 * code outside the popular list is stored and shown exactly as typed, never converted.
 *
 * Every accepted value — whether picked from the list or typed — is normalised to a bare,
 * upper-cased code via {@link currencyCodeFromInput}, so `"EUR — Euro"` and `"eur"` both store
 * `"EUR"`. A blank field means "use the base currency". The `(i)` hint spells out what a valid
 * value looks like.
 */
export function CurrencyAutocompleteField({
  value,
  onChange,
  hint = DEFAULT_CURRENCY_HINT,
  ...rest
}: CurrencyAutocompleteFieldProps) {
  return (
    <AutocompleteField
      value={value}
      onChange={(next) => onChange(currencyCodeFromInput(next))}
      suggestions={CURRENCY_SUGGESTIONS}
      maxOptions={CURRENCY_SUGGESTIONS.length}
      maxLength={3}
      hint={hint}
      {...rest}
    />
  );
}
