import { Banner } from '@/components/foundry';
import { WarningIcon } from '@/components/icons';
import { useT } from '@/features/i18n';

/**
 * What kind of record was left out of the totals — which decides the copy and the test id.
 *
 * `items` is the valuation case (issue #284): stock whose supplier quotes a foreign price.
 * `orders` is the spend case (issue #285): a purchase order raised in a foreign currency. The
 * refusal is identical in both — Gubbins holds no exchange rates — so they share one component
 * rather than two that must be kept in step by hand.
 */
export type ForeignCurrencyScope = 'items' | 'orders';

/** Per-scope catalog keys and test id. Keys stay string literals so `t()` type-checks them. */
const SCOPES = {
  items: {
    heading: 'reports.foreignCurrency.heading',
    body: 'reports.foreignCurrency.body',
    testId: 'foreign-currency-notice',
  },
  orders: {
    heading: 'reports.spendForeignCurrency.heading',
    body: 'reports.spendForeignCurrency.body',
    testId: 'spend-foreign-currency-notice',
  },
} as const;

/**
 * Warns that some records are missing from the totals on screen because they are priced in a
 * currency other than the user's base one (issues #284, #285).
 *
 * Gubbins stores a price verbatim and holds no exchange rates, so a ¥ price can neither be summed
 * into a £ total nor converted into one. The valuation and spend queries therefore decline it —
 * but an exclusion nobody can see is its own kind of wrong answer, especially on the insurance
 * schedule, where the reader is a third party who cannot know that stock is missing. This says so
 * plainly, and names the way out: give the item a cost of its own, or record the price in the
 * base currency.
 *
 * Renders nothing when `count` is 0 or still loading, so callers can mount it unconditionally.
 */
export function ForeignCurrencyNotice({
  count,
  baseCurrency,
  scope = 'items',
  className,
}: {
  /** Records excluded from the totals — e.g. the value of `useForeignCurrencyCostCount`. */
  count: number | undefined;
  /** The user's base currency code, named so the reader knows which currency the totals are in. */
  baseCurrency: string;
  /** Which totals this notice qualifies; defaults to the valuation (items) case. */
  scope?: ForeignCurrencyScope;
  className?: string;
}) {
  const t = useT();
  const { heading, body, testId } = SCOPES[scope];
  if (!count) return null;
  return (
    <Banner
      tone="warning"
      icon={<WarningIcon aria-hidden />}
      heading={t(heading, { vars: { count } })}
      className={className}
      data-testid={testId}
    >
      {t(body, { vars: { count, currency: baseCurrency } })}
    </Banner>
  );
}
