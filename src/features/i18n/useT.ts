/**
 * useT — the React seam every component translates through (feature-gap G4).
 *
 * The text counterpart to `useFormatters`: it binds the active-language catalog + the base English
 * catalog + the formatting locale into one memoised {@link Translator}, so the UI language and the
 * number/date/currency formatting always share the one locale. Typed to the known {@link MessageKey}
 * union, so a mistyped key is a compile error rather than a silent English fallback at runtime.
 */
import { useMemo } from 'react';
import { usePreferencesStore } from '@/state/stores/usePreferencesStore';
import { makeTranslator, type TranslateOptions } from './i18n';
import { EN_CATALOG, type MessageKey } from './messages';
import { useI18nStore } from './useI18nStore';

/** A translator typed to the known message keys (missing translations fall back to English). */
export type TypedTranslator = (key: MessageKey, options?: TranslateOptions) => string;

export function useT(): TypedTranslator {
  const locale = usePreferencesStore((s) => s.locale);
  const catalog = useI18nStore((s) => s.catalog);
  // `makeTranslator` is a pure function of `[catalog, locale]`, so one memoised instance per
  // preference pair gives every component a stable `t` reference across renders.
  return useMemo(() => makeTranslator(catalog, EN_CATALOG, locale), [catalog, locale]);
}
