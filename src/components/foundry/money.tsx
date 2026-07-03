import { Fragment } from 'react';
import { cn } from '@/lib/utils';
import type { Formatters } from '@/lib/format';
import { useFormatters } from '@/lib/useFormatters';

export interface MoneyProps {
  /** The monetary amount. A non-finite value renders the em-dash placeholder. */
  readonly value: number;
  /**
   * Optional ISO-4217 override — render `value` under *this* currency's own symbol
   * (e.g. a per-supplier `EUR`) rather than the user's base currency. Presentation only,
   * never converted; see {@link Formatters.currency}.
   */
  readonly currency?: string;
  /**
   * Use this formatter bundle instead of the {@link useFormatters} hook. Pass it when the
   * caller already has a bundle in scope (e.g. a report component that receives one via
   * props for dependency-injected testability) so a screen full of prices shares a single
   * bundle rather than each `Money` reaching for the store. Omit it and the hook is used.
   */
  readonly formatters?: Formatters;
  /** Classes merged onto the wrapping `<span>`. */
  readonly className?: string;
  /** Extra classes merged onto the tinted currency-symbol `<span>`. */
  readonly symbolClassName?: string;
  readonly 'data-testid'?: string;
}

/**
 * Foundry Money — the single, canonical way to render a cost/price anywhere in the app.
 *
 * It formats `value` in the user's base currency (or an optional per-value ISO override)
 * via the shared {@link useFormatters} bundle, then paints the **currency symbol** in its
 * own {@link money-symbol} token colour at 0.8 opacity so it reads as a distinct affordance
 * ahead of the neutral-coloured digits — e.g. a muted `£` before a foreground `4.25`. All
 * the formatting rules (locale, grouping, the override/fallback behaviour) live once in the
 * formatter; this component only owns the split-and-tint presentation, so every price across
 * the app looks and behaves identically without any call site repeating the logic.
 *
 * The value is emitted as plain in-order text spans, so assistive tech and copy-paste read
 * it exactly as the equivalent string (`£4.25`) with no reordering.
 */
export function Money({
  value,
  currency,
  formatters,
  className,
  symbolClassName,
  'data-testid': testId,
}: MoneyProps) {
  // The hook must run unconditionally (Rules of Hooks); an explicit `formatters` prop simply
  // takes precedence over it. Both resolve to the same store-bound bundle at runtime.
  const hookFormatters = useFormatters();
  const fmt = formatters ?? hookFormatters;
  const parts = fmt.currencyParts(value, currency);

  if (!parts) {
    return (
      <span className={cn('tabular-nums', className)} data-testid={testId}>
        —
      </span>
    );
  }

  return (
    <span className={cn('tabular-nums', className)} data-testid={testId}>
      {parts.map((part, index) =>
        part.type === 'currency' ? (
          <span key={`${part.type}-${index}`} className={cn('text-money-symbol opacity-80', symbolClassName)}>
            {part.value}
          </span>
        ) : (
          <Fragment key={`${part.type}-${index}`}>{part.value}</Fragment>
        ),
      )}
    </span>
  );
}
