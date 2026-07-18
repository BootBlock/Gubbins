/**
 * Registrable-domain host matching — the single answer to "is this host really theirs?".
 *
 * A keyword-shaped pattern (`/lcsc\.[a-z.]+$/`, `*lcsc*`) cannot tell a supplier's real
 * domain from a look-alike that merely *contains* the keyword: `lcsc.evil.com` satisfies
 * both, and an attacker controls the registration. The only safe test is against a curated
 * list of registrable domains, matching the apex or any subdomain of it — which is what
 * this does.
 *
 * Pure and dependency-free, so it is shared by the scraping parsers' host routing, the
 * extension's fetch allow-list, and the importer's supplier-code recognition rather than
 * each re-deriving it (and each getting it subtly different).
 */

/**
 * Whether `hostname` is one of `domains`, or a subdomain of one. Case- and
 * trailing-dot-insensitive; a blank or unparseable hostname never matches.
 *
 * Matching is on a label boundary, so `lcsc.com` matches `www.lcsc.com` but never
 * `notlcsc.com` or `lcsc.com.evil.net`.
 */
export function isHostWithinDomains(hostname: string, domains: readonly string[]): boolean {
  const host = hostname.trim().toLowerCase().replace(/\.$/, '');
  if (host.length === 0) return false;
  return domains.some((raw) => {
    const domain = raw.trim().toLowerCase().replace(/\.$/, '');
    return domain.length > 0 && (host === domain || host.endsWith(`.${domain}`));
  });
}

/**
 * {@link isHostWithinDomains} applied to a URL string. Returns `false` for anything that
 * is not a parseable absolute URL — callers routing a scrape target should never treat a
 * malformed URL as a match.
 */
export function isUrlWithinDomains(rawUrl: string, domains: readonly string[]): boolean {
  try {
    return isHostWithinDomains(new URL(rawUrl).hostname, domains);
  } catch {
    return false;
  }
}
