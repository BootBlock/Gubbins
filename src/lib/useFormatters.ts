/**
 * useFormatters — bind the pure {@link makeFormatters} factory to the Tier-2
 * preferences (spec §3, §2.1). The single React seam through which every component
 * formats currency, numbers, percentages, byte sizes and dates in the user's chosen
 * base currency and locale. Memoised per `[locale, currency]` so the heavyweight
 * `Intl.*Format` objects are built only when a preference actually changes.
 */
import { useMemo } from 'react';
import { usePreferencesStore } from '@/state/stores/usePreferencesStore';
import { makeFormatters, type Formatters } from './format';

export function useFormatters(): Formatters {
  const locale = usePreferencesStore((s) => s.locale);
  const currency = usePreferencesStore((s) => s.baseCurrency);
  return useMemo(() => makeFormatters(locale, currency), [locale, currency]);
}
