/**
 * Public i18n surface (feature-gap G4). Components import `useT`; the composition root mounts
 * `useApplyLanguage`; the Settings language control reads `SUPPORTED_LANGUAGES` / `languageForLocale`.
 * The pure seam (`i18n.ts`) and its catalogs stay internal — glue talks to it only through here.
 */
export { useT, type TypedTranslator } from './useT';
export { useApplyLanguage } from './useApplyLanguage';
export {
  BASE_LANGUAGE,
  EN_CATALOG,
  SUPPORTED_LANGUAGES,
  hasInterfaceTranslation,
  languageForLocale,
  loadCatalog,
  type LanguageDef,
  type MessageKey,
} from './messages';
export { useI18nStore } from './useI18nStore';
export type { MessageCatalog, TranslateOptions, TranslateVars, Translator } from './i18n';
