/**
 * useFormatters — bind the pure {@link makeFormatters} factory to the Tier-2
 * preferences (spec §3, §2.1). The single React seam through which every component
 * formats currency, numbers, percentages, byte sizes and dates in the user's chosen
 * base currency and locale. Memoised per `[locale, currency]` so the heavyweight
 * `Intl.*Format` objects are built only when a preference actually changes.
 */
import { usePreferencesStore } from '@/state/stores/usePreferencesStore';
import { getFormatters, type Formatters } from './format';

export function useFormatters(): Formatters {
  const locale = usePreferencesStore((s) => s.locale);
  const currency = usePreferencesStore((s) => s.baseCurrency);
  const weightUnit = usePreferencesStore((s) => s.weightUnit);
  const dimensionUnit = usePreferencesStore((s) => s.dimensionUnit);
  // `getFormatters` returns a stable, process-wide-cached bundle per `[locale, currency,
  // weightUnit, dimensionUnit]`, so the reference is already stable across renders (and shared
  // across every component) — no per-component `useMemo` needed.
  return getFormatters(locale, currency, weightUnit, dimensionUnit);
}
