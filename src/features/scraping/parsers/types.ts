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

const CURRENCY_BY_SYMBOL: Record<string, string> = { '£': 'GBP', $: 'USD', '€': 'EUR', '¥': 'JPY' };

/**
 * Parse a price string (`"£0.42"`, `"0.42 GBP"`, `"$1,234.56"`) into a strict
 * `{ currency, value }`. Throws §9.4.2 when no finite number can be extracted —
 * never returns `NaN`. `defaultCurrency` covers a bare number with no symbol/code.
 */
export function parsePrice(text: string, defaultCurrency = 'GBP'): { currency: string; value: number } {
  const raw = text.trim();
  if (raw.length === 0) throw new DomDriftError('Empty price string.');

  let currency: string | null = null;
  for (const [symbol, code] of Object.entries(CURRENCY_BY_SYMBOL)) {
    if (raw.includes(symbol)) {
      currency = code;
      break;
    }
  }
  if (!currency) {
    const code = raw.match(/\b([A-Z]{3})\b/);
    if (code) currency = code[1]!;
  }

  // Strip thousands separators, keep the first decimal group. Preserve a leading
  // minus so a negative price is rejected rather than silently flipped positive.
  const negative = /-\s*[\d.]/.test(raw);
  const numeric = raw.replace(/[^\d.,]/g, '').replace(/,(?=\d{3}\b)/g, '');
  const magnitude = Number.parseFloat(numeric.replace(/,/g, '.'));
  if (!Number.isFinite(magnitude)) throw new DomDriftError(`Unparseable price "${text}".`);
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
