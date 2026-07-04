/**
 * Amazon product-page parser (spec §9.4.1) — a **hand-written** host-specific Strategy.
 *
 * Amazon does not fit the {@link makeSupplierParser} factory: the factory reads the MPN
 * from a CSS text node, but Amazon has no MPN concept — the stable identifier is the
 * **ASIN**, which lives in the *URL* (`/dp/<ASIN>`) or a hidden `#ASIN` input, not a
 * visible text node. So this parser derives the ASIN itself and emits it as the payload's
 * `mpn`. Downstream, `supplier-part-plan.ts` writes `mpn`→`orderCode` and derives the
 * supplier name (`Amazon`) from the host, so the ASIN lands as the Amazon supplier part's
 * order code with **no change to the persistence layer** — exactly the §9 data-model fit
 * recorded in `docs/todo/amazon-import_2026-07-03.md`.
 *
 * ## Active-tab only (Path A2) — never background-fetched (Path A1 is declined)
 *
 * Amazon aggressively defeats cookieless server-side fetches (Robot Check / CAPTCHA /
 * stripped pages), so Amazon is **deliberately absent** from the background-fetch
 * allow-list (`EXTENSION_HOST_PERMISSIONS` in `suppliers.ts`) and from `manifest.json`'s
 * `host_permissions`. This parser only ever runs against the **live DOM of the Amazon tab
 * the user already has open**, injected on an explicit user action via the extension's
 * `activeTab` permission — the price is present, the locale/currency correct, and there is
 * no bot challenge because it is the user's own authenticated page. The parser itself is
 * pure (it just reads a `Document`), so it is unit-tested under happy-dom against
 * **synthetic** Amazon-shaped fixtures and bundled unchanged into the extension.
 */
import { asinToUrl, marketplaceFromHost, normaliseAsin, parseAsin, isAmazonHost } from '../../inventory/asin';
import { type ScrapeResultPayload } from '../protocol';
import { metaContent } from './metadata';
import { DomDriftError, optionalText, parsePrice, type SupplierParser } from './types';

/** The buy-box price selectors, most-specific first; each `.a-offscreen` holds the full
 *  localized price string (`"£9.99"`), so {@link parsePrice} infers the currency from its
 *  symbol. Scoped to the core price blocks before the bare fallback so a strike-through
 *  list price elsewhere on the page is not picked up ahead of the actual buy-box price. */
const PRICE_SELECTORS = [
  '#corePriceDisplay_desktop_feature_div .a-price .a-offscreen',
  '#corePrice_feature_div .a-price .a-offscreen',
  '#price_inside_buybox',
  '#priceblock_ourprice',
  '#priceblock_dealprice',
  '#tp_price_block_total_price_ww .a-offscreen',
  '#apex_desktop .a-price .a-offscreen',
  '.a-price .a-offscreen',
] as const;

/** The product title, then structured-metadata fallbacks. */
const TITLE_SELECTORS = ['#productTitle', '#title', 'h1#title'] as const;

/** The brand/byline row, then the details-table brand cell. */
const BRAND_SELECTORS = [
  '#bylineInfo',
  'a#bylineInfo',
  '#brand',
  'tr.po-brand td.a-span9 span.po-break-word',
  '#detailBullets_feature_div .a-list-item .a-text-bold + span',
] as const;

/**
 * Tidy Amazon's byline into a bare brand. Amazon renders the brand as `"Visit the Acme
 * Store"` (the store link) or `"Brand: Acme"` (a details row); strip either wrapper so the
 * item's manufacturer is just `Acme`. Anything else is returned trimmed as-is.
 */
function cleanBrand(raw: string): string {
  const text = raw.replace(/\s+/g, ' ').trim();
  const store = /^visit the (.+?) store$/i.exec(text);
  if (store) return store[1]!.trim();
  const labelled = /^brand[:\s]+(.+)$/i.exec(text);
  if (labelled) return labelled[1]!.trim();
  return text;
}

/**
 * Extract the ASIN, preferring the URL (`/dp/<ASIN>`, `/gp/product/<ASIN>`, …) since on a
 * live product tab it is always present and unambiguous. Falls back to the hidden `#ASIN`
 * input Amazon embeds, then to any element's `data-asin` that is a valid ASIN. Returns
 * `null` when none is found, so {@link amazonParser.parse} can raise a precise §9.4.2 drift.
 */
function extractAsin(doc: ParentNode, url: string): string | null {
  const fromUrl = parseAsin(url);
  if (fromUrl) return fromUrl;

  const inputs = [
    doc.querySelector('input#ASIN'),
    doc.querySelector('input[name="ASIN"]'),
    doc.querySelector('#ASIN'),
  ];
  for (const el of inputs) {
    const asin = el ? normaliseAsin(el.getAttribute('value') ?? '') : null;
    if (asin) return asin;
  }

  for (const el of doc.querySelectorAll('[data-asin]')) {
    const asin = normaliseAsin(el.getAttribute('data-asin') ?? '');
    if (asin) return asin;
  }
  return null;
}

export const amazonParser: SupplierParser = {
  id: 'amazon',
  label: 'Amazon',
  matches(url: string): boolean {
    try {
      return isAmazonHost(new URL(url).hostname);
    } catch {
      return false;
    }
  },
  parse(doc: Document, url: string): ScrapeResultPayload {
    const asin = extractAsin(doc, url);
    if (!asin) {
      throw new DomDriftError(
        'Amazon: no ASIN found — not a product page, or the URL/#ASIN input has moved.',
      );
    }

    // The title is what the item's description/name is filled from. Fall back to the page
    // metadata/title so a layout tweak degrades gracefully rather than losing everything.
    const description =
      optionalText(doc, TITLE_SELECTORS) ??
      metaContent(doc, ['meta[property="og:title"]', 'meta[name="title"]']) ??
      optionalText(doc, ['title']) ??
      '';

    const brand = optionalText(doc, BRAND_SELECTORS) ?? metaContent(doc, ['meta[property="product:brand"]']);
    const manufacturer = brand ? cleanBrand(brand) : '';

    const priceText = optionalText(doc, PRICE_SELECTORS);
    // A marketplace default (from the live host) covers a bare price with no symbol.
    const marketplace = marketplaceFromHost(new URL(url).hostname) ?? undefined;
    const fallbackCurrency = marketplace === 'com' ? 'USD' : 'GBP';
    const scraped_pricing = priceText ? parsePrice(priceText, fallbackCurrency) : null;

    // The durable link is the canonical /dp/<ASIN> on the *live* tab's marketplace, so the
    // enriched item links back to the same locale/currency the user was viewing.
    const distributor_url = asinToUrl(asin, marketplace);

    return { mpn: asin, manufacturer, description: description.trim(), distributor_url, scraped_pricing };
  },
};
