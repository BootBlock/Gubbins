import { type FocusEvent, type InputHTMLAttributes, forwardRef, useCallback } from 'react';
import { snapMoneyInput, type Formatters } from '@/lib/format';
import { useFormatters } from '@/lib/useFormatters';
import { Input } from './input';

export interface MoneyInputProps extends Omit<
  InputHTMLAttributes<HTMLInputElement>,
  'value' | 'onChange' | 'type'
> {
  /** The controlled string value (kept a string so an in-progress edit is never coerced). */
  readonly value: string;
  /** Called with the new string on every keystroke, and again with the snapped value on blur. */
  readonly onValueChange: (value: string) => void;
  /**
   * ISO-4217 code whose fraction digits the value snaps to on blur — e.g. a per-supplier
   * `EUR`. Defaults to the user's base currency (the common case: a price in base currency).
   */
  readonly currency?: string;
  /**
   * Use this formatter bundle instead of the {@link useFormatters} hook — pass it when the
   * caller already has a bundle in scope. Omit it and the hook is used.
   */
  readonly formatters?: Formatters;
}

/**
 * Foundry MoneyInput — the canonical control for **entering** a monetary amount, the input
 * counterpart to the {@link Money} display control.
 *
 * It is a plain numeric field while focused, then on blur pads the value up to the number of
 * fraction digits its currency is written with — `8` becomes `8.00` for GBP/USD/EUR, stays
 * `8` for JPY, becomes `8.000` for BHD — using {@link Formatters.currencyFractionDigits} so the
 * decimals always match the user's currency localisation. The snap is presentation only and
 * **lossless**: it pads to the currency's canonical precision but never rounds away precision
 * the user typed, so the stored number is unchanged — `1234.56` under JPY stays `1234.56`, a
 * 4-decimal `0.0125` unit cost under GBP stays `0.0125`. Rounding a figure to its currency's
 * scale is the money seam's job at compute time, not a side effect of leaving the field. A
 * blank value stays blank (prices are optional) and in-progress/invalid text is left untouched.
 *
 * Renders a bare {@link Input} — pair it with a `<label>` or drop it inside a `FormField`,
 * which clones in the label/ARIA wiring exactly as it does for a plain `Input`.
 */
export const MoneyInput = forwardRef<HTMLInputElement, MoneyInputProps>(
  ({ value, onValueChange, currency, formatters, onBlur, ...props }, ref) => {
    const hookFormatters = useFormatters();
    const fmt = formatters ?? hookFormatters;
    const handleBlur = useCallback(
      (event: FocusEvent<HTMLInputElement>) => {
        const snapped = snapMoneyInput(value, fmt.currencyFractionDigits(currency));
        if (snapped !== value) onValueChange(snapped);
        onBlur?.(event);
      },
      [value, fmt, currency, onValueChange, onBlur],
    );
    return (
      <Input
        ref={ref}
        type="number"
        inputMode="decimal"
        min={0}
        step="any"
        value={value}
        onChange={(event) => onValueChange(event.target.value)}
        onBlur={handleBlur}
        {...props}
      />
    );
  },
);
MoneyInput.displayName = 'MoneyInput';
