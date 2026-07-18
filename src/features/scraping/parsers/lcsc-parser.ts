/**
 * LCSC product-page parser (spec §9.4.1) — a host-specific Strategy.
 *
 * ## Deliberately selector-free
 *
 * LCSC's product pages are rendered by a component framework that emits only generated,
 * hashed utility class names — there is no semantic CSS hook to select, and no `[itemprop]`
 * microdata anywhere on the page. Selectors written against that markup match nothing while
 * still *reading* as precise, which is the worst of both worlds: the scrape fails on every
 * real page, and the failure looks like ordinary DOM drift rather than a parser that never
 * matched.
 *
 * What LCSC does emit — reliably, because search engines require it — is a schema.org
 * `Product` JSON-LD block carrying `mpn`, `brand.name`, `description` and
 * `offers.price`/`offers.priceCurrency`. The shared {@link makeSupplierParser} fallback
 * reads exactly that, so this parser is intentionally configured with **no host selectors**
 * and leans entirely on structured metadata.
 *
 * `offers.priceCurrency` matters for correctness, not just coverage: LCSC prices in **USD**
 * and exposes no currency `<meta>` tag, so without the JSON-LD currency a scraped price
 * would fall back to the `parsePrice` default and be recorded in the wrong currency.
 *
 * This entry stays in the registry (rather than deferring to the generic fallback) so LCSC
 * keeps its own id/label for UI and logging, and so its host routing is pinned to the real
 * `lcsc.com` domain. Should LCSC ever ship stable hooks, add a `selectors` block here — the
 * factory prefers host selectors over metadata automatically.
 */
import { makeSupplierParser } from './metadata';

export const lcscParser = makeSupplierParser({
  id: 'lcsc',
  label: 'LCSC',
  domains: ['lcsc.com'],
});
