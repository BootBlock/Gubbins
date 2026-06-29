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
import { EXTENSION_HOST_PERMISSIONS, isAllowedSupplierUrl } from './suppliers';
import { SUPPLIER_PARSERS } from './registry';

// Vitest runs from the project root, so resolve the manifest relative to cwd (the test
// env's import.meta.url is an http: URL under happy-dom, not a file: URL).
const manifestPath = resolve(process.cwd(), 'extension/manifest.json');
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { host_permissions?: string[] };

describe('extension host_permissions (§9 / §4 hardening)', () => {
  it('no longer grants the broad <all_urls> permission', () => {
    expect(manifest.host_permissions).not.toContain('<all_urls>');
  });

  it('matches the supplier allowlist source of truth exactly', () => {
    expect(manifest.host_permissions).toEqual([...EXTENSION_HOST_PERMISSIONS]);
  });

  it('covers every host-specific registered parser', () => {
    // Each non-generic parser id should map to at least one allowed host pattern.
    const hostParserIds = SUPPLIER_PARSERS.map((p) => p.id).filter((id) => id !== 'generic-meta');
    for (const id of hostParserIds) {
      const covered = EXTENSION_HOST_PERMISSIONS.some((pat) => pat.includes(`.${id}.`) || pat.includes(`.${id}-`));
      expect(covered, `no host_permission covers parser "${id}"`).toBe(true);
    }
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
