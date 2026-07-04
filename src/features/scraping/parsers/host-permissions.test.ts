/**
 * Guards the §9/§4 production hardening: the extension manifest's `host_permissions`
 * must stay narrowed to the supplier allowlist and never drift back to `<all_urls>`.
 *
 * Reads the real `extension/manifest.json` and asserts it equals the single source of
 * truth (`EXTENSION_HOST_PERMISSIONS`), so adding/removing a supplier domain in one
 * place without the other fails CI rather than shipping a broken or over-broad grant.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ALL_EXTENSION_HOST_PERMISSIONS,
  EXTENSION_HOST_PERMISSIONS,
  isAllowedLookupUrl,
  isAllowedSupplierUrl,
} from './suppliers';
import { SUPPLIER_PARSERS } from './registry';

// Vitest runs from the project root, so resolve the manifest relative to cwd (the test
// env's import.meta.url is an http: URL under happy-dom, not a file: URL).
const manifestPath = resolve(process.cwd(), 'extension/manifest.json');
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { host_permissions?: string[] };

describe('extension host_permissions (§9 / §4 hardening)', () => {
  it('no longer grants the broad <all_urls> permission', () => {
    expect(manifest.host_permissions).not.toContain('<all_urls>');
  });

  it('matches the combined allowlist source of truth exactly (suppliers + product lookup)', () => {
    expect(manifest.host_permissions).toEqual([...ALL_EXTENSION_HOST_PERMISSIONS]);
  });

  it('still carries every supplier host, and the product-lookup host', () => {
    for (const host of EXTENSION_HOST_PERMISSIONS) expect(manifest.host_permissions).toContain(host);
    expect(manifest.host_permissions).toContain('https://*.openfoodfacts.org/*');
  });

  it('covers every background-fetch parser (Amazon deliberately excepted — active-tab only)', () => {
    // Each background-fetch parser id should map to at least one allowed host pattern. The
    // generic fallback is not a supplier; `amazon` is Path A2 (active-tab, injected into the
    // user's live tab), NOT Path A1 (background fetch) — so it is intentionally kept OUT of
    // the fetch allow-list and host_permissions, and must not be asserted here.
    const backgroundFetchIds = SUPPLIER_PARSERS.map((p) => p.id).filter(
      (id) => id !== 'generic-meta' && id !== 'amazon',
    );
    for (const id of backgroundFetchIds) {
      const covered = EXTENSION_HOST_PERMISSIONS.some(
        (pat) => pat.includes(`.${id}.`) || pat.includes(`.${id}-`),
      );
      expect(covered, `no host_permission covers parser "${id}"`).toBe(true);
    }
  });

  it('does NOT grant a background-fetch host_permission for Amazon (A1 is declined)', () => {
    // Guard the A2-vs-A1 decision: no Amazon host may leak into the fetch allow-list, and the
    // background-fetch gate must refuse an Amazon URL (that path is the declined, ToS-hostile A1).
    for (const pat of EXTENSION_HOST_PERMISSIONS) expect(pat).not.toContain('amazon');
    expect(isAllowedSupplierUrl('https://www.amazon.co.uk/dp/B0TEST00001')).toBe(false);
    expect(isAllowedSupplierUrl('https://www.amazon.com/dp/B0TEST00001')).toBe(false);
  });
});

describe('isAllowedSupplierUrl (§9 background-fetch gate)', () => {
  it('allows an https supplier domain and its subdomains', () => {
    expect(isAllowedSupplierUrl('https://www.digikey.com/en/products/detail/x')).toBe(true);
    expect(isAllowedSupplierUrl('https://digikey.com/x')).toBe(true);
    expect(isAllowedSupplierUrl('https://uk.farnell.com/x')).toBe(true);
    expect(isAllowedSupplierUrl('https://www.digikey.co.uk/x')).toBe(true);
  });

  it('rejects non-https schemes', () => {
    expect(isAllowedSupplierUrl('http://www.digikey.com/x')).toBe(false);
    expect(isAllowedSupplierUrl('file:///etc/passwd')).toBe(false);
    expect(isAllowedSupplierUrl('data:text/html,<script>1</script>')).toBe(false);
  });

  it('rejects a non-supplier host', () => {
    expect(isAllowedSupplierUrl('https://evil.example.com/x')).toBe(false);
    expect(isAllowedSupplierUrl('https://localhost/x')).toBe(false);
    expect(isAllowedSupplierUrl('https://169.254.169.254/latest/meta-data')).toBe(false);
  });

  it('is not fooled by a look-alike host that merely ends in the domain text', () => {
    // `digikey.com.evil.test` and `notdigikey.com` must not match `digikey.com`.
    expect(isAllowedSupplierUrl('https://digikey.com.evil.test/x')).toBe(false);
    expect(isAllowedSupplierUrl('https://notdigikey.com/x')).toBe(false);
  });

  it('rejects a userinfo-disguised host and unparseable input', () => {
    expect(isAllowedSupplierUrl('https://www.digikey.com@evil.test/x')).toBe(false);
    expect(isAllowedSupplierUrl('not a url')).toBe(false);
  });
});

describe('isAllowedLookupUrl (product-lookup fetch gate, point 2)', () => {
  it('allows the Open Food Facts https host and its subdomains', () => {
    expect(isAllowedLookupUrl('https://world.openfoodfacts.org/api/v2/product/12345.json')).toBe(true);
    expect(isAllowedLookupUrl('https://openfoodfacts.org/x')).toBe(true);
  });

  it('rejects non-https, a supplier host, and other origins', () => {
    expect(isAllowedLookupUrl('http://world.openfoodfacts.org/x')).toBe(false);
    expect(isAllowedLookupUrl('https://www.digikey.com/x')).toBe(false);
    expect(isAllowedLookupUrl('https://openfoodfacts.org.evil.test/x')).toBe(false);
  });
});
