/**
 * The Strategy-pattern parser contract + DOM-drift helpers (spec §9.4).
 *
 * Each supplier gets a discrete {@link SupplierParser} (no monolithic if/else tree,
 * §9.4.1) behind a uniform interface returning the §9.2 `ScrapeResultPayload`. The
 * shared helpers enforce §9.4.2 "no silent failures": a missing selector or an
 * unparseable price throws a {@link DomDriftError}, which a parser marshals into an
 * explicit `SCRAPE_ERROR` rather than guessing, returning `null`, or emitting `NaN`.
 *
 * Pure (operates on a standard `Document`) so it is unit-tested under happy-dom and
 * bundled unchanged into the extension's background worker.
 */
import { parseMoneyNumber } from '../../inventory/ocr/receipt-ocr';
import { type ScrapeErrorPayload, type ScrapeResultPayload } from '../protocol';

/** Raised when the DOM no longer matches a parser's expectations (§9.4.2). */
export class DomDriftError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = 'DomDriftError';
  }
}

/** A parse either yields the strict payload or an explicit, typed error. */
export type ParseOutcome =
  | { readonly ok: true; readonly payload: ScrapeResultPayload }
  | { readonly ok: false; readonly error: ScrapeErrorPayload };

export interface SupplierParser {
  /** Stable id (e.g. `digikey`). */
  readonly id: string;
  /** Human label for UI/logging (e.g. `DigiKey`). */
  readonly label: string;
  /** Whether this parser handles the given product URL (host match). */
  matches(url: string): boolean;
  /**
   * Parse a fetched product document. Implementations should lean on the shared
   * helpers so any structural drift surfaces as a {@link DomDriftError} rather than
   * a partial/garbage payload.
   */
  parse(doc: Document, url: string): ScrapeResultPayload;
}

/** First non-blank text content among the selectors, or throw §9.4.2. */
export function requireText(doc: ParentNode, selectors: string | readonly string[], label: string): string {
  const list = typeof selectors === 'string' ? [selectors] : selectors;
  for (const sel of list) {
    const el = doc.querySelector(sel);
    const text = el?.textContent?.trim();
    if (text) return text;
  }
  throw new DomDriftError(`Missing "${label}" — selector(s) ${list.join(', ')} matched no text.`);
}

/** First non-blank text among selectors, or null (for genuinely optional fields). */
export function optionalText(doc: ParentNode, selectors: string | readonly string[]): string | null {
  const list = typeof selectors === 'string' ? [selectors] : selectors;
  for (const sel of list) {
    const text = doc.querySelector(sel)?.textContent?.trim();
    if (text) return text;
  }
  return null;
}

/** Read a non-blank attribute, or throw §9.4.2. */
export function requireAttr(doc: ParentNode, selector: string, attr: string, label: string): string {
  const value = doc.querySelector(selector)?.getAttribute(attr)?.trim();
  if (!value) throw new DomDriftError(`Missing "${label}" — ${selector}[${attr}] absent or empty.`);
  return value;
}

/**
 * Currency marks that appear beside a rendered price, scanned in order. The prefixed dollars
 * come first so `CDN$`, `A$` and `R$` are read before the bare `$` they contain; that
 * ordering is what the list is for, so add a new dollar prefix above `$` rather than at the
 * end.
 *
 * Several marks are shared by more than one currency, and each is read as the one it most
 * often means: `$` as USD, `¥` as JPY over CNY, `£` as GBP over the other pound currencies.
 * A mark whose readings have no such favourite is left out entirely rather than guessed at —
 * `kr` is SEK, NOK, DKK or ISK with nothing to choose between them, and a confident wrong
 * currency is worse than none. Callers that know the locale (the Amazon marketplace, a page's
 * `priceCurrency`) pass the code in and settle any of these properly.
 */
const CURRENCY_BY_SYMBOL: readonly (readonly [string, string])[] = [
  ['CDN$', 'CAD'],
  ['US$', 'USD'],
  ['CA$', 'CAD'],
  ['AU$', 'AUD'],
  ['NZ$', 'NZD'],
  ['HK$', 'HKD'],
  ['MX$', 'MXN'],
  ['C$', 'CAD'],
  ['A$', 'AUD'],
  ['S$', 'SGD'],
  ['R$', 'BRL'],
  ['£', 'GBP'],
  ['€', 'EUR'],
  ['¥', 'JPY'],
  ['₹', 'INR'],
  ['₽', 'RUB'],
  ['₩', 'KRW'],
  ['₪', 'ILS'],
  ['₺', 'TRY'],
  ['฿', 'THB'],
  ['₫', 'VND'],
  ['zł', 'PLN'],
  ['Kč', 'CZK'],
  ['$', 'USD'],
];

/**
 * ISO 4217 codes recognised when a page writes the currency out (`12.99 EUR`). A known-code
 * list rather than a bare three-letter scan, so an ordinary word in the price line (`VAT`,
 * `EAC`) is not adopted as a currency, and matched case-sensitively, because a code is written
 * in capitals and a lower-case `try` or `ron` is a verb rather than a currency.
 */
const CURRENCY_CODES = (
  'GBP USD EUR JPY CHF CNY INR CAD AUD NZD SGD HKD SEK NOK DKK ISK PLN CZK HUF RON ' +
  'BGN TRY RUB UAH BRL MXN ARS CLP ZAR AED SAR EGP ILS KRW TWD THB MYR IDR PHP VND'
).split(' ');
const CURRENCY_CODE_RE = new RegExp(String.raw`\b(${CURRENCY_CODES.join('|')})\b`);

/**
 * A space, non-breaking space or apostrophe used as a **thousands** separator (`1 234,56`,
 * `1'299.00`), matched only where it sits between a digit and a following three-digit group.
 * That shape is what a grouped number looks like, but it is not exclusive to one: a price
 * line reading `Buy 2 500ml bottles £9.99` fits it too, and joins into 2500. The narrower
 * reading is still the better bet, because a price element holding a leading quantity is far
 * rarer than a European price holding a grouping space.
 */
const GROUPING_GAP_RE = /(\d)[\s\u00a0\u202f'\u2019](?=\d{3}(?:\D|$))/g;

/** The first run of digits and separators in a price string. */
const PRICE_TOKEN_RE = /\d[\d.,]*/;

/** A bare machine-written amount: digits, optionally one dot and a fraction. */
const MACHINE_AMOUNT_RE = /^\d+(?:\.\d+)?$/;

/** Options for {@link parsePrice}. */
export interface ParsePriceOptions {
  /**
   * The text came from a **machine-written** field (a JSON-LD `price`, a `product:price:amount`
   * meta tag) rather than the rendered page. schema.org writes such a value dot-decimal and
   * ungrouped, so `"1.234"` is one and a bit — not the 1234 the same string means in a German
   * price *label*. Only that otherwise-ambiguous shape is affected: a grouped or comma-decimal
   * value (which European sites do emit into meta tags in defiance of the schema) still goes
   * through the convention-resolving reader below.
   */
  readonly machineFormat?: boolean;
}

/**
 * Read the numeric magnitude out of a price string, resolving both decimal conventions.
 *
 * Delegates to {@link parseMoneyNumber} — the same reader the receipt OCR and the CSV
 * importer use — so a scraped `1.299,00 €` and an imported `1.299,00` agree. Returns null
 * when no plausible amount is present.
 *
 * Where both separators appear the right-most is the decimal point and the reading is exact.
 * A **lone** separator before a three-digit tail is genuinely undecidable — `1.299` is 1299
 * to a German page and one-and-a-bit to a British one — and that reader takes it as grouping,
 * which is right for the `1.299 €` a European site renders when a price has no cents, and
 * wrong for a distributor quoting `£1.234` to three decimals. Machine-written fields are not
 * subject to the guess at all; see {@link ParsePriceOptions.machineFormat}.
 */
function priceMagnitude(raw: string, machineFormat: boolean): number | null {
  const token = raw
    .replace(GROUPING_GAP_RE, '$1')
    .match(PRICE_TOKEN_RE)?.[0]
    // A trailing separator is sentence punctuation, not part of the number.
    .replace(/[.,]+$/, '');
  if (!token) return null;
  if (machineFormat && MACHINE_AMOUNT_RE.test(token)) return Number(token);
  return parseMoneyNumber(token);
}

/**
 * Parse a price string (`"£0.42"`, `"0.42 GBP"`, `"$1,234.56"`, `"1.299,00 €"`) into a strict
 * `{ currency, value }`. Throws §9.4.2 when no finite number can be extracted —
 * never returns `NaN`. `defaultCurrency` covers a bare number with no symbol/code.
 */
export function parsePrice(
  text: string,
  defaultCurrency = 'GBP',
  options: ParsePriceOptions = {},
): { currency: string; value: number } {
  const raw = text.trim();
  if (raw.length === 0) throw new DomDriftError('Empty price string.');

  // The mark beside the number wins, and a written-out code only settles a price that carries
  // no mark at all. The other way round reads any word that spells a code — `try`, `ron` — as
  // the currency of the price it sits beside. A page that states its currency properly says so
  // in `priceCurrency`, and those callers overwrite the result afterwards.
  let currency: string | null = null;
  for (const [symbol, symbolCode] of CURRENCY_BY_SYMBOL) {
    if (raw.includes(symbol)) {
      currency = symbolCode;
      break;
    }
  }
  if (!currency) {
    const code = raw.match(CURRENCY_CODE_RE);
    if (code) currency = code[1]!;
  }

  // Preserve a leading minus so a negative price is rejected rather than silently flipped
  // positive; the reader itself only ever sees the unsigned token.
  const negative = /-\s*[\d.,]*\d/.test(raw);
  const magnitude = priceMagnitude(raw, options.machineFormat ?? false);
  if (magnitude === null || !Number.isFinite(magnitude)) {
    throw new DomDriftError(`Unparseable price "${text}".`);
  }
  if (negative || magnitude < 0) throw new DomDriftError(`Negative price "${text}".`);
  const value = magnitude;

  return { currency: currency ?? defaultCurrency, value };
}

/** Hostname of a URL, lower-cased, or `''` if it cannot be parsed. */
export function hostOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return '';
  }
}
