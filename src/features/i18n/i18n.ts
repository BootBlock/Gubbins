/**
 * Pure i18n seam (feature-gap G4 — UI internationalization).
 *
 * The whole of the non-trivial translation logic lives here and nothing else does — no React,
 * no store, no DOM, no catalog *files*. That keeps the four rules a message layer actually has
 * to get right exhaustively unit-testable in isolation (the same "logic out of glue" seam as
 * `format.ts`, `valuation.ts`, `reorder-policy.ts`):
 *
 *  1. **Lookup** — resolve a dotted message key against the active-language catalog.
 *  2. **Interpolation** — substitute `{name}` placeholders from caller-supplied values, with any
 *     *numeric* value rendered through the same locale as the rest of the app (§ shared locale, so
 *     "1,234 items" groups the way `format.ts` groups everything else).
 *  3. **Pluralization** — when a `count` is supplied, pick the CLDR plural category for the locale
 *     (`Intl.PluralRules`) and prefer the matching `key.<category>` variant.
 *  4. **Fallback** — a key missing from the active catalog falls back to the **base (English)**
 *     catalog, then to an explicit caller fallback, then to the key itself, so a missing
 *     translation degrades to legible English rather than a blank or a crash.
 *
 * The React layer (`useT`) binds a catalog + base + locale into a {@link Translator}; every
 * component formats through that, exactly as every component formats money through `useFormatters`.
 */
import { DEFAULT_LOCALE } from '@/lib/format';

/** A flat map of dotted message key → message template. Immutable once loaded. */
export type MessageCatalog = Readonly<Record<string, string>>;

/** Interpolation values. A numeric `count` additionally selects the plural variant. */
export type TranslateVars = Readonly<Record<string, string | number>>;

export interface TranslateOptions {
  /** Values substituted into `{placeholder}` tokens; a numeric `count` also picks the plural. */
  readonly vars?: TranslateVars;
  /** Used when the key is absent from *both* the active and the base catalog (before the key). */
  readonly fallback?: string;
}

/** A catalog+base+locale-bound translate function — the shape every component consumes. */
export type Translator = (key: string, options?: TranslateOptions) => string;

/** `{name}` placeholder — a run of word characters between braces. */
const PLACEHOLDER = /\{(\w+)\}/g;

/**
 * Memoised `Intl.NumberFormat` per locale for interpolating numeric vars. Numbers substituted
 * into a message (a plural `count`, an "N of M" total) are grouped in the active locale so text
 * and numbers read as one — the same reason `format.ts` caches its formatters: these run in list
 * rows, so the heavyweight `Intl` object must not be rebuilt on every substitution.
 */
const numberFormatters = new Map<string, Intl.NumberFormat>();

function numberFormatterFor(locale: string): Intl.NumberFormat {
  const cached = numberFormatters.get(locale);
  if (cached) return cached;
  let fmt: Intl.NumberFormat;
  try {
    fmt = new Intl.NumberFormat(locale);
  } catch {
    // A malformed locale can never reach the catalog; fall back to the locked default.
    fmt = new Intl.NumberFormat(DEFAULT_LOCALE);
  }
  numberFormatters.set(locale, fmt);
  return fmt;
}

/**
 * The CLDR plural category for `count` in `locale` (`'one'`, `'other'`, and for some languages
 * `'few'`/`'many'`/…). A non-finite count or a malformed locale resolves to `'other'` — the
 * category every language defines — so a bad input can never throw here.
 */
export function selectPluralCategory(locale: string, count: number): Intl.LDMLPluralRule {
  if (!Number.isFinite(count)) return 'other';
  try {
    return new Intl.PluralRules(locale).select(count);
  } catch {
    try {
      return new Intl.PluralRules(DEFAULT_LOCALE).select(count);
    } catch {
      return 'other';
    }
  }
}

/**
 * Substitute `{name}` tokens in `template` from `vars`. A numeric value is rendered through the
 * active locale's grouping; a string value is inserted verbatim (so a caller can pass an
 * already-formatted price/date). An unknown token is left **intact** (`{name}`) rather than blanked,
 * so a wiring mistake is visible in the UI instead of silently vanishing. Pure and injectable.
 */
export function interpolate(template: string, vars: TranslateVars | undefined, locale: string): string {
  if (!vars) return template;
  return template.replace(PLACEHOLDER, (whole, name: string) => {
    const value = vars[name];
    if (value === undefined) return whole;
    return typeof value === 'number' ? numberFormatterFor(locale).format(value) : value;
  });
}

/**
 * Resolve the raw template for `key` in a single catalog. With a plural `category`, the
 * `key.<category>` variant is preferred, then the always-defined `key.other`, then a bare
 * (non-pluralized) `key` — so a caller may pass `count` even to a message that has no variants.
 * Returns `undefined` when the catalog has nothing for the key, letting the caller fall back.
 */
function resolveTemplate(
  catalog: MessageCatalog,
  key: string,
  category: Intl.LDMLPluralRule | undefined,
): string | undefined {
  if (category) {
    return catalog[`${key}.${category}`] ?? catalog[`${key}.other`] ?? catalog[key];
  }
  return catalog[key];
}

/**
 * Translate `key` against the `catalog` (active language), falling back to `base` (English), then
 * to `options.fallback`, then to the key itself. The single choke-point both `translate`-style unit
 * tests and the React {@link makeTranslator} run through, so glue and tests can never diverge.
 */
export function translate(
  key: string,
  catalog: MessageCatalog,
  base: MessageCatalog,
  locale: string,
  options?: TranslateOptions,
): string {
  const vars = options?.vars;
  const count = typeof vars?.count === 'number' ? vars.count : undefined;
  const category = count === undefined ? undefined : selectPluralCategory(locale, count);
  const template =
    resolveTemplate(catalog, key, category) ??
    resolveTemplate(base, key, category) ??
    options?.fallback ??
    key;
  return interpolate(template, vars, locale);
}

/**
 * Bind a catalog + base + locale into a reusable {@link Translator}. Mirrors `makeFormatters`:
 * the React seam builds one per `[language, locale]` and memoises it, so components get a stable
 * `t` reference and the resolution rules stay in this pure module.
 */
export function makeTranslator(catalog: MessageCatalog, base: MessageCatalog, locale: string): Translator {
  return (key, options) => translate(key, catalog, base, locale, options);
}
