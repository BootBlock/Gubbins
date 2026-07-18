/**
 * Multi-supplier order-code recognition for the free-form paste importer — the same
 * pattern {@link ./asin} uses for Amazon, generalised to the handful of other suppliers
 * whose listing URL or order-code shape maps *unambiguously* to a real, orderable part
 * code. A supplier is only added here once its code is either lifted from a fixed,
 * confirmed URL path segment, or has a distinctive-enough bare shape to auto-detect in
 * loose invoice text without false-positiving on an ordinary SKU or model number — the
 * same bar {@link ./asin}'s `B0…` ASIN rule sets. Mouser and SparkFun are deliberately
 * absent: neither exposes its own order code in the product URL (both carry only the
 * manufacturer's part number or an unrelated slug), and neither has a bare shape
 * distinctive enough to detect safely — add them once a reliable signal is found.
 *
 * Amazon itself is not duplicated here: {@link ./asin}'s `findAsin` already covers it,
 * and the importer ({@link ./text-import}) tries that first.
 */

/**
 * The shared registrable-domain test, so the importer, the scraping parsers' host routing
 * and the extension allow-list all agree on what "their domain" means.
 */
import { isHostWithinDomains } from '../../lib/host-match';

/** A recognised supplier order code and the exact substring it was found in. */
export interface SupplierCodeMatch {
  readonly supplier: string;
  readonly code: string;
  readonly matchedText: string;
}

/** One supplier's listing-URL recognition: a domain keyword, its real registrable domains, and a path extractor. */
interface UrlRule {
  readonly supplier: string;
  /** Bare keyword used to spot a same-domain URL inside loose text (e.g. `lcsc`). */
  readonly domainKeyword: string;
  /**
   * The supplier's genuine registrable domain(s) (e.g. `lcsc.com`), matched at the apex or
   * under any subdomain. A curated list — rather than a loose "keyword-dot-anything"
   * pattern — is what tells the real domain from a look-alike where the keyword is merely
   * a subdomain of someone else's domain (`lcsc.evil.com`); the same reasoning
   * {@link ./asin}'s `isAmazonHost` uses its curated TLD set for.
   */
  readonly registrableDomains: readonly string[];
  /** Matched against `new URL(url).pathname`; group 1 is the order code. */
  readonly pathPattern: RegExp;
}

/**
 * Suppliers whose own order code sits in a fixed, confirmed path segment of the listing
 * URL: LCSC's `/product-detail/<code>.html`, RS's `/web/p/<slug>/<code>`, Farnell's
 * `/…/dp/<code>`, and Adafruit's `/product/<code>`. None of these codes has a shape
 * distinctive enough to recognise as a bare token (see {@link LCSC_BARE_RE} for the one
 * exception), so — unlike Amazon and LCSC — most are only recognised inside a full URL.
 */
const URL_RULES: readonly UrlRule[] = [
  {
    supplier: 'LCSC',
    domainKeyword: 'lcsc',
    registrableDomains: ['lcsc.com'],
    pathPattern: /\/product-detail\/(C\d+)\.html/i,
  },
  {
    supplier: 'RS Components',
    domainKeyword: 'rs-online',
    registrableDomains: ['rs-online.com'],
    pathPattern: /\/web\/p\/[^/]+\/(\d{5,9})(?:[/?]|$)/i,
  },
  {
    supplier: 'Farnell',
    domainKeyword: 'farnell',
    registrableDomains: ['farnell.com'],
    pathPattern: /\/dp\/(\d{5,9})(?:[/?]|$)/i,
  },
  {
    supplier: 'Adafruit',
    domainKeyword: 'adafruit',
    registrableDomains: ['adafruit.com'],
    pathPattern: /\/product\/(\d+)(?:[/?]|$)/i,
  },
];

/** An `http(s)` URL on the given bare domain keyword, matched loosely inside a larger string. */
function looseUrlPattern(domainKeyword: string): RegExp {
  return new RegExp(`https?://[^\\s<>"']*${domainKeyword}\\.[^\\s<>"']*`, 'i');
}

/**
 * Try to pull a supplier code out of a URL substring found inside `text`, for one
 * {@link UrlRule}. Mirrors {@link ./asin}'s `findAsin`: a loose, domain-keyword finder
 * locates a candidate URL first, then a strict host + path check derives the code — so a
 * look-alike domain (`lcsc.evil.com`) or an unrelated path never yields a false positive.
 */
function findUrlCode(text: string, rule: UrlRule): SupplierCodeMatch | null {
  const found = looseUrlPattern(rule.domainKeyword).exec(text);
  if (!found) return null;
  let url: URL;
  try {
    url = new URL(found[0]);
  } catch {
    return null;
  }
  if (!isHostWithinDomains(url.hostname, rule.registrableDomains)) return null;
  const path = rule.pathPattern.exec(url.pathname);
  if (!path) return null;
  return { supplier: rule.supplier, code: path[1]!.toUpperCase(), matchedText: found[0] };
}

/**
 * LCSC's own part number: a `C` prefix plus 4–8 digits (e.g. `C7461236`), also confirmed
 * to appear verbatim in the listing URL ({@link URL_RULES}) — the closest analogue to
 * Amazon's ASIN, safe to auto-detect as a bare token too.
 */
const LCSC_BARE_RE = /\bC\d{4,8}\b/i;

/**
 * DigiKey's orderable part number: the manufacturer part number plus a packaging suffix
 * that always ends `-ND` (`-ND`, `-CT-ND`, `-TR-ND`, `-DKR-ND`, `-1-ND`, …). DigiKey's
 * product URL carries only an internal numeric page id and the bare manufacturer part
 * number — never this suffixed code — so, unlike the suppliers in {@link URL_RULES}, it
 * is recognised only as a bare token, never from a URL.
 */
const DIGIKEY_BARE_RE = /\b[A-Z0-9][A-Z0-9-]{4,28}-ND\b/i;

/** Find a bare LCSC part number, or `null`. */
function findLcscBare(text: string): SupplierCodeMatch | null {
  const m = LCSC_BARE_RE.exec(text);
  return m ? { supplier: 'LCSC', code: m[0].toUpperCase(), matchedText: m[0] } : null;
}

/** Find a bare DigiKey part number, or `null`. */
function findDigikeyBare(text: string): SupplierCodeMatch | null {
  const m = DIGIKEY_BARE_RE.exec(text);
  return m ? { supplier: 'DigiKey', code: m[0].toUpperCase(), matchedText: m[0] } : null;
}

/**
 * Find the first recognised supplier order code inside a block of free text (typically
 * one invoice / paste line). A listing URL is tried first — across every {@link URL_RULES}
 * entry, in the order listed — then a bare LCSC or DigiKey token, mirroring
 * {@link ./asin}'s `findAsin` URL-before-bare-token priority. Returns `null` when nothing
 * recognised is present. Amazon is not tried here — see the module doc.
 */
export function findSupplierCode(text: string): SupplierCodeMatch | null {
  for (const rule of URL_RULES) {
    const found = findUrlCode(text, rule);
    if (found) return found;
  }
  return findLcscBare(text) ?? findDigikeyBare(text);
}
