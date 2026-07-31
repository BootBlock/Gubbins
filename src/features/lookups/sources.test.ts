import { describe, expect, it } from 'vitest';
import { DATA_LOOKUP_HOST_PERMISSIONS } from '@/features/scraping/parsers/suppliers';
import { CSP_DIRECTIVES } from '@/csp';
import { isHostWithinDomains } from '@/lib/host-match';
import { getLookupProvider, LOOKUP_PROVIDERS, LOOKUP_PROVIDER_HOSTS } from './registry';
import { hasRunnableLookup, resolveLookupSources } from './sources';

describe('the provider registry', () => {
  it('resolves a known id and answers undefined for an unknown one', () => {
    expect(getLookupProvider('wikidata-film')?.id).toBe('wikidata-film');
    expect(getLookupProvider('musicbrainz-release')).toBeUndefined();
  });

  it('has unique ids, since a category stores one and a duplicate would be ambiguous', () => {
    expect(new Set(LOOKUP_PROVIDERS.map((p) => p.id)).size).toBe(LOOKUP_PROVIDERS.length);
  });

  it('gives every provider unique output keys — a stored fieldMap keys on them', () => {
    for (const provider of LOOKUP_PROVIDERS) {
      const keys = provider.outputs.map((o) => o.key);
      expect(new Set(keys).size, provider.id).toBe(keys.length);
    }
  });

  it('declares at least one host per provider, since the host is the consent unit', () => {
    for (const provider of LOOKUP_PROVIDERS) {
      expect(provider.hosts.length, provider.id).toBeGreaterThan(0);
      expect(provider.minIntervalMs, provider.id).toBeGreaterThan(0);
    }
  });
});

/**
 * The two-places rule (issue #616): a provider host must be allow-listed in the extension
 * manifest **and** in CSP `connect-src`. They are independent lists, and missing either one blocks
 * the fetch on that path — a blocked request being indistinguishable, from JavaScript, from the
 * host simply being down. Deriving both checks from the registry means adding a provider whose
 * host nobody allow-listed fails the build instead of failing silently at the first click.
 */
describe('every provider host is allow-listed in both independent places', () => {
  it('is covered by the extension manifest’s data-lookup host permissions', () => {
    const domains = DATA_LOOKUP_HOST_PERMISSIONS.map((pattern) =>
      pattern
        .replace(/^https:\/\//, '')
        .replace(/\/.*$/, '')
        .replace(/^\*\./, '')
        .toLowerCase(),
    );
    for (const host of LOOKUP_PROVIDER_HOSTS) {
      expect(isHostWithinDomains(host, domains), `no host_permission covers ${host}`).toBe(true);
    }
  });

  it('is named exactly in the CSP connect-src directive', () => {
    const connectSrc = CSP_DIRECTIVES.find(([name]) => name === 'connect-src')?.[1] ?? '';
    const sources = connectSrc.split(/\s+/);
    for (const host of LOOKUP_PROVIDER_HOSTS) {
      expect(sources, `connect-src does not name ${host}`).toContain(`https://${host}`);
    }
  });
});

describe('resolveLookupSources', () => {
  it('resolves a stored id to its provider, carrying the fieldMap through', () => {
    const resolved = resolveLookupSources([{ providerId: 'wikidata-film', fieldMap: { director: 'f1' } }]);
    expect(resolved).toHaveLength(1);
    expect(resolved[0]!.provider.id).toBe('wikidata-film');
    expect(resolved[0]!.fieldMap).toEqual({ director: 'f1' });
  });

  it('ignores an id this build has no provider for, without discarding the rest', () => {
    // An unresolvable id is an ordinary state — a peer on a newer version, or a provider withdrawn
    // from a later build — not a fault. Storage keeps it; this is where the tolerance ends.
    const resolved = resolveLookupSources([
      { providerId: 'from-the-future', fieldMap: null },
      { providerId: 'wikidata-film', fieldMap: null },
    ]);
    expect(resolved.map((r) => r.provider.id)).toEqual(['wikidata-film']);
  });

  it('reads null, undefined and an empty list as no lookups', () => {
    expect(resolveLookupSources(null)).toEqual([]);
    expect(resolveLookupSources(undefined)).toEqual([]);
    expect(resolveLookupSources([])).toEqual([]);
  });
});

describe('hasRunnableLookup — the cheap guard', () => {
  it('is true only when this build can actually run something', () => {
    expect(hasRunnableLookup([{ providerId: 'wikidata-film', fieldMap: null }])).toBe(true);
    expect(hasRunnableLookup([{ providerId: 'from-the-future', fieldMap: null }])).toBe(false);
    expect(hasRunnableLookup(null)).toBe(false);
  });
});
