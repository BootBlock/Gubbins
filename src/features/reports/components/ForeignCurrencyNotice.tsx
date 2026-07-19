import { Banner } from '@/components/foundry';
import { WarningIcon } from '@/components/icons';
import { useT } from '@/features/i18n';

/**
 * Warns that some stock is missing from the totals on screen because its price is quoted in a
 * currency other than the user's base one (issue #284).
 *
 * Gubbins stores a supplier part's price verbatim and holds no exchange rates, so a ¥ price can
 * neither be summed into a £ total nor converted into one. The valuation queries therefore
 * decline it — but an exclusion nobody can see is its own kind of wrong answer, especially on
 * the insurance schedule, where the reader is a third party who cannot know that stock is
 * missing. This says so plainly, and names the two ways out: give the item a cost of its own,
 * or re-quote the part in the base currency.
 *
 * Renders nothing when `count` is 0 or still loading, so callers can mount it unconditionally.
 */
export function ForeignCurrencyNotice({
  count,
  baseCurrency,
  className,
}: {
  /** Items excluded from the totals — the value of `useForeignCurrencyCostCount`. */
  count: number | undefined;
  /** The user's base currency code, named so the reader knows which currency the totals are in. */
  baseCurrency: string;
  className?: string;
}) {
  const t = useT();
  if (!count) return null;
  return (
    <Banner
      tone="warning"
      icon={<WarningIcon aria-hidden />}
      heading={t('reports.foreignCurrency.heading', { vars: { count } })}
      className={className}
      data-testid="foreign-currency-notice"
    >
      {t('reports.foreignCurrency.body', { vars: { count, currency: baseCurrency } })}
    </Banner>
  );
}
