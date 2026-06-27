/**
 * Supplier parser registry & the uniform parse entry point (spec §9.4).
 *
 * Strategy selection (§9.4.1): host-specific parsers are tried first, then the
 * generic structured-metadata fallback. {@link runParser} wraps a parser so the
 * §9.4.2 contract holds — a {@link DomDriftError} (or any thrown error) becomes an
 * explicit `SCRAPE_ERROR` payload, never a partial/`NaN` result — giving the uniform
 * {@link ParseOutcome} the bridge marshals across the §9 wire unchanged.
 */
import { type ScrapeErrorType } from '../protocol';
import { digikeyParser } from './digikey-parser';
import { genericMetaParser } from './generic-meta-parser';
import { DomDriftError, hostOf, type ParseOutcome, type SupplierParser } from './types';

/** Host-specific strategies, highest priority first; generic fallback last. */
export const SUPPLIER_PARSERS: readonly SupplierParser[] = [digikeyParser, genericMetaParser];

/** Pick the first parser that claims the URL (the generic fallback always does). */
export function selectParser(url: string): SupplierParser | null {
  return SUPPLIER_PARSERS.find((p) => p.matches(url)) ?? null;
}

/**
 * Parse a fetched product document into the uniform {@link ParseOutcome}. Any drift
 * or unexpected throw is caught and marshalled into a typed `SCRAPE_ERROR` (§9.4.2),
 * defaulting to `DOM_DRIFT`. Callers (the extension background worker) can override
 * `errorType` for transport-level failures (`NETWORK_TIMEOUT`, `RATE_LIMITED`).
 */
export function runParser(doc: Document, url: string): ParseOutcome {
  const parser = selectParser(url);
  const domain = hostOf(url);
  if (!parser) {
    return { ok: false, error: { domain, error_type: 'DOM_DRIFT', reason: 'No parser for this supplier.' } };
  }
  try {
    return { ok: true, payload: parser.parse(doc, url) };
  } catch (err) {
    const errorType: ScrapeErrorType = 'DOM_DRIFT';
    const reason = err instanceof DomDriftError ? err.message : `Unexpected parse failure: ${String(err)}`;
    return { ok: false, error: { domain, error_type: errorType, reason } };
  }
}
