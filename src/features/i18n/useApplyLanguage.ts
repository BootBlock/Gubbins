/**
 * useApplyLanguage — keep the active message catalog in sync with the formatting locale (G4).
 *
 * Mounted once at the composition root, beside `useApplyTheme`. English needs no load (it is the
 * store default and the always-bundled fallback); a translated language lazy-imports its catalog and
 * swaps it in when ready. Until it arrives — and for any key it doesn't translate — the base English
 * shows, so the interface is always legible and nothing flashes blank.
 */
import { useEffect } from 'react';
import { usePreferencesStore } from '@/state/stores/usePreferencesStore';
import { BASE_LANGUAGE, EN_CATALOG, languageForLocale, loadCatalog } from './messages';
import { useI18nStore } from './useI18nStore';

export function useApplyLanguage(): void {
  const locale = usePreferencesStore((s) => s.locale);
  useEffect(() => {
    const language = languageForLocale(locale);
    if (language === BASE_LANGUAGE) {
      // English (or any untranslated locale): apply the bundled base synchronously — no flash.
      useI18nStore.getState().setLanguage(BASE_LANGUAGE, EN_CATALOG);
      return;
    }
    // A translated language: import its catalog, but ignore a stale resolution if the locale
    // changed again while awaiting (the user flipping languages quickly).
    let cancelled = false;
    void loadCatalog(language).then((catalog) => {
      if (!cancelled) useI18nStore.getState().setLanguage(language, catalog);
    });
    return () => {
      cancelled = true;
    };
  }, [locale]);
}
