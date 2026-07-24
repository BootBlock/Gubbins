import { type ReactNode, useMemo } from 'react';
import { CURRENCY_OPTIONS } from '@/lib/format';
import { Select, SelectField, type SelectOption } from './select';
import { type TooltipSize } from './tooltip';

/**
 * The label the "no explicit currency" row falls back to when a caller doesn't supply its
 * own (translated) one. Callers that go through the i18n seam pass a `t()` value; the
 * not-yet-translated screens rely on this English default.
 */
export const DEFAULT_CURRENCY_NONE_LABEL = 'Use base currency';

/**
 * Build the option list a currency picker offers: the popular {@link CURRENCY_OPTIONS} as
 * `CODE — Name` rows, optionally led by a blank "use base currency" row for the fields where
 * a currency is *optional*. A non-empty `value` that isn't one of the offered codes is
 * appended verbatim so an existing off-list code (imported or entered before it was offered)
 * still shows and round-trips rather than silently blanking.
 */
function buildCurrencyOptions(value: string, allowNone: boolean, noneLabel: string): SelectOption[] {
  const options: SelectOption[] = [];
  if (allowNone) options.push({ value: '', label: noneLabel });
  for (const c of CURRENCY_OPTIONS) options.push({ value: c.value, label: `${c.value} — ${c.label}` });
  if (value && !CURRENCY_OPTIONS.some((c) => c.value === value)) options.push({ value, label: value });
  return options;
}

export interface CurrencySelectProps {
  /** The current ISO-4217 code, or `''` for "none" when {@link CurrencySelectProps.allowNone} is set. */
  readonly value: string;
  readonly onChange: (value: string) => void;
  /**
   * Offer a leading blank row for the fields where a currency is optional (a supplier's
   * default, a purchase order's currency): choosing it clears the value to `''`, which the
   * caller stores as "use the base currency". Omitted, the picker only offers real codes.
   */
  readonly allowNone?: boolean;
  /** Label for the blank row; defaults to {@link DEFAULT_CURRENCY_NONE_LABEL}. */
  readonly noneLabel?: string;
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
 * Foundry CurrencySelect — the app-wide control for picking a currency, the bare combobox
 * counterpart to {@link CurrencyField}. It wraps the Foundry {@link Select} pre-loaded with
 * the offered {@link CURRENCY_OPTIONS} so every currency field (Settings' base currency, a
 * supplier's default, a supplier part's or purchase order's currency) offers the same list
 * and reads the same way — one definition, not a picker hand-rolled per screen.
 *
 * Name it with `aria-label`/`aria-labelledby` (a `role="combobox"` element can't be named by
 * a wrapping `<label>`); the {@link CurrencyField} wrapper handles the labelled-field case.
 */
export function CurrencySelect({
  value,
  onChange,
  allowNone = false,
  noneLabel = DEFAULT_CURRENCY_NONE_LABEL,
  className,
  disabled,
  placeholder,
  'aria-label': ariaLabel,
  'aria-labelledby': ariaLabelledBy,
  'aria-describedby': ariaDescribedBy,
  'aria-invalid': ariaInvalid,
  'data-testid': testId,
}: CurrencySelectProps) {
  const options = useMemo(
    () => buildCurrencyOptions(value, allowNone, noneLabel),
    [value, allowNone, noneLabel],
  );
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

export interface CurrencyFieldProps {
  readonly label: ReactNode;
  readonly value: string;
  readonly onChange: (value: string) => void;
  /** See {@link CurrencySelectProps.allowNone}. */
  readonly allowNone?: boolean;
  /** Label for the blank row; defaults to {@link DEFAULT_CURRENCY_NONE_LABEL}. */
  readonly noneLabel?: string;
  /** Validation message; when present the control is marked invalid and this is announced. */
  readonly error?: string;
  /** Optional rich-Markdown help, surfaced via an `i` badge (like {@link SelectField}). */
  readonly hint?: string;
  readonly hintSize?: TooltipSize;
  readonly className?: string;
  readonly placeholder?: string;
  readonly disabled?: boolean;
  readonly 'data-testid'?: string;
}

/**
 * A labelled {@link CurrencySelect} — the currency counterpart to
 * {@link import('./select').SelectField}. It is what a form field for a currency uses, wiring
 * the label, hint badge and validation error exactly as a labelled Select does.
 */
export function CurrencyField({
  value,
  onChange,
  allowNone = false,
  noneLabel = DEFAULT_CURRENCY_NONE_LABEL,
  ...rest
}: CurrencyFieldProps) {
  const options = useMemo(
    () => buildCurrencyOptions(value, allowNone, noneLabel),
    [value, allowNone, noneLabel],
  );
  return <SelectField value={value} onChange={onChange} options={options} {...rest} />;
}
