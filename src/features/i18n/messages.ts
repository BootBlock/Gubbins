/**
 * Message-catalog registry (feature-gap G4).
 *
 * The base **English** catalog (`catalogs/en.json`) is the single source of truth for every UI
 * string in the converted slice: it is statically bundled (it is the fallback for every key, so it
 * must always be present) and its keys type the {@link MessageKey} union that `useT` accepts. Every
 * other language is an *override* catalog that is lazily imported only when the user selects it, so a
 * language costs nothing in the base bundle until it is chosen. Adding a language is one entry in
 * {@link SUPPORTED_LANGUAGES} plus its `catalogs/<code>.json`.
 */
import en from './catalogs/en.json';
import type { MessageCatalog } from './i18n';

/** The base (source-of-truth) English catalog — always bundled; the fallback for every key. */
export const EN_CATALOG: MessageCatalog = en;

/** The CLDR plural categories a pluralized message key is suffixed with (`items.count.one`). */
type PluralCategory = 'zero' | 'one' | 'two' | 'few' | 'many' | 'other';

/** The literal keys present in the base catalog (leaf keys, plural variants included). */
type LeafKey = keyof typeof en & string;

/**
 * The *base* of a pluralized key: `items.count.one` / `items.count.other` → `items.count`. A caller
 * passes the base key plus a `count`, and the seam resolves the right `.<category>` variant — so the
 * base must be a valid key to `useT` even though only its variants literally exist in the catalog.
 * Written as a generic so the conditional **distributes** over the `LeafKey` union (a conditional on
 * a concrete union type does not distribute; only a naked type parameter does).
 */
type PluralBaseOf<K extends string> = K extends `${infer Base}.${PluralCategory}` ? Base : never;

/** Every key `useT` accepts: each literal catalog key, plus the base of every pluralized key. */
export type MessageKey = LeafKey | PluralBaseOf<LeafKey>;

/** The base language code — English needs no async load (it *is* the bundled fallback). */
export const BASE_LANGUAGE = 'en';

export interface LanguageDef {
  /** Base subtag, e.g. `de`. */
  readonly code: string;
  /** The language's own name for itself, shown in the picker (deliberately never translated). */
  readonly endonym: string;
  /** Lazily import the override catalog; omitted for the base language (already bundled). */
  readonly load?: () => Promise<MessageCatalog>;
}

/**
 * Supported UI languages, in display order. English is the base; German (G4 pilot) lazy-imports its
 * catalog. `de-DE` is already offered by the Settings locale control, so selecting it now also
 * switches the interface to German — text and number/date/currency share the one locale.
 */
export const SUPPORTED_LANGUAGES: readonly LanguageDef[] = [
  { code: 'en', endonym: 'English' },
  { code: 'de', endonym: 'Deutsch', load: () => import('./catalogs/de.json').then((m) => m.default) },
];

const LANGUAGE_CODES = new Set(SUPPORTED_LANGUAGES.map((l) => l.code));

/** The base subtag of a BCP-47 locale (`de-DE` → `de`); best-effort split for a malformed tag. */
function baseSubtag(locale: string): string {
  try {
    return new Intl.Locale(locale).language;
  } catch {
    return locale.split(/[-_]/)[0]?.toLowerCase() || BASE_LANGUAGE;
  }
}

/**
 * Resolve the active UI language from the formatting locale (§ shared locale): the locale's base
 * subtag when a catalog exists for it, else English. So `de-DE`/`de-AT` → German; `en-US` and any
 * locale we don't (yet) translate → English. A single locale drives both the language and the
 * number/date/currency formatting, so the two can never disagree.
 */
export function languageForLocale(locale: string): string {
  const code = baseSubtag(locale);
  return LANGUAGE_CODES.has(code) ? code : BASE_LANGUAGE;
}

/** Load the catalog for a language code; the bundled English catalog for the base / anything unknown. */
export async function loadCatalog(code: string): Promise<MessageCatalog> {
  const def = SUPPORTED_LANGUAGES.find((l) => l.code === code);
  return def?.load ? def.load() : EN_CATALOG;
}
