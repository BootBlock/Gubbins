/**
 * Runtime cache of the active message catalog (feature-gap G4).
 *
 * Deliberately **not persisted**: the UI language is derived from the persisted `locale`
 * preference (`usePreferencesStore`), so this store is only the in-memory home for the currently
 * loaded catalog. It starts on the bundled English base and `useApplyLanguage` swaps in a
 * lazy-loaded override catalog when the locale selects a translated language.
 */
import { create } from 'zustand';
import type { MessageCatalog } from './i18n';
import { BASE_LANGUAGE, EN_CATALOG } from './messages';

interface I18nStore {
  /** The active UI language code (`en`, `de`, …). */
  readonly language: string;
  /** The active language's catalog (English until a translated one loads). */
  readonly catalog: MessageCatalog;
  /** Swap in a loaded catalog for a language (called by `useApplyLanguage`). */
  setLanguage: (language: string, catalog: MessageCatalog) => void;
}

export const useI18nStore = create<I18nStore>((set) => ({
  language: BASE_LANGUAGE,
  catalog: EN_CATALOG,
  setLanguage: (language, catalog) => set({ language, catalog }),
}));
