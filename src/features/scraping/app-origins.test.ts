/**
 * Guards the §9.1 injection surface (issue #493): the extension may only run on the Gubbins
 * PWA, and the manifest that decides where it runs must stay pinned to the one source of truth.
 *
 * The bug this replaces was not a missing check — it was a check that could not fail. The
 * content script trusted `window.location.origin`, and the manifest injected it into every
 * `*.github.io` site and every `http://localhost` page, so "the page's own origin" was
 * whatever hostile page happened to host it. The assertions below are therefore as much about
 * what must *not* match as what must.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { repoPath } from '../../test/repo-path';
import { DEFAULT_BASE_PATH } from '../../base-path';
import { GUBBINS_APP_ORIGINS, GUBBINS_APP_URL_PATTERNS, isGubbinsAppUrl } from './app-origins';

// Resolved from *this file's* checkout, never `process.cwd()` — see `repoPath`.
const manifestPath = repoPath(import.meta.dirname, 'extension', 'manifest.json');
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
  content_scripts?: { matches?: string[]; js?: string[] }[];
};

describe('extension content_scripts.matches (§9.1 injection surface)', () => {
  const matches = manifest.content_scripts?.[0]?.matches ?? [];

  it('matches the single source of truth exactly', () => {
    expect(matches).toEqual([...GUBBINS_APP_URL_PATTERNS]);
  });

  it('never injects by host wildcard or by bare host, on any origin', () => {
    // `https://*.github.io/*` is every GitHub Pages site on the internet; `http://localhost/*`
    // is every dev server on the machine, because a match pattern cannot pin a port.
    for (const pattern of matches) {
      expect(pattern).not.toContain('*.');
      expect(pattern).not.toContain('<all_urls>');
      expect(pattern.endsWith(`${DEFAULT_BASE_PATH}*`), pattern).toBe(true);
    }
  });

  it('injects only the content script, and only on the documented origins', () => {
    expect(manifest.content_scripts).toHaveLength(1);
    expect(manifest.content_scripts?.[0]?.js).toEqual(['content-script.js']);
    expect(matches).toContain('https://bootblock.github.io/Gubbins/*');
  });
});

describe('isGubbinsAppUrl', () => {
  it('accepts the hosted deployment and a dev server on any port', () => {
    expect(isGubbinsAppUrl('https://bootblock.github.io/Gubbins/')).toBe(true);
    expect(isGubbinsAppUrl('https://bootblock.github.io/Gubbins/items/1?q=x#f')).toBe(true);
    expect(isGubbinsAppUrl('http://localhost:5173/Gubbins/')).toBe(true);
    expect(isGubbinsAppUrl('http://127.0.0.1:4173/Gubbins/settings')).toBe(true);
  });

  it('rejects another GitHub Pages site — the whole point of issue #493', () => {
    expect(isGubbinsAppUrl('https://attacker.github.io/anything')).toBe(false);
    expect(isGubbinsAppUrl('https://attacker.github.io/Gubbins/')).toBe(false);
    expect(isGubbinsAppUrl('https://github.io/Gubbins/')).toBe(false);
  });

  it('rejects another path on an allowed host', () => {
    // A GitHub Pages account serves every one of its projects from one origin, so the path is
    // the only thing separating Gubbins from a sibling project there.
    expect(isGubbinsAppUrl('https://bootblock.github.io/')).toBe(false);
    expect(isGubbinsAppUrl('https://bootblock.github.io/other-project/')).toBe(false);
    expect(isGubbinsAppUrl('http://localhost:3000/')).toBe(false);
    expect(isGubbinsAppUrl('http://localhost:3000/some-app/')).toBe(false);
  });

  it('is not fooled by a look-alike host, a userinfo disguise, or a path prefix', () => {
    expect(isGubbinsAppUrl('https://bootblock.github.io.evil.test/Gubbins/')).toBe(false);
    expect(isGubbinsAppUrl('https://evil.bootblock.github.io/Gubbins/')).toBe(false);
    expect(isGubbinsAppUrl('https://bootblock.github.io@evil.test/Gubbins/')).toBe(false);
    expect(isGubbinsAppUrl('https://user:pw@bootblock.github.io/Gubbins/')).toBe(false);
    expect(isGubbinsAppUrl('https://bootblock.github.io/Gubbins-evil/')).toBe(false);
  });

  it('requires the scheme each origin is actually served over', () => {
    expect(isGubbinsAppUrl('http://bootblock.github.io/Gubbins/')).toBe(false);
    expect(isGubbinsAppUrl('https://localhost:5173/Gubbins/')).toBe(false);
    expect(isGubbinsAppUrl('file:///Gubbins/index.html')).toBe(false);
    expect(isGubbinsAppUrl('javascript:alert(1)')).toBe(false);
  });

  it('rejects a missing or unparseable URL rather than throwing', () => {
    expect(isGubbinsAppUrl(undefined)).toBe(false);
    expect(isGubbinsAppUrl(null)).toBe(false);
    expect(isGubbinsAppUrl('')).toBe(false);
    expect(isGubbinsAppUrl('not a url')).toBe(false);
  });

  it('agrees with the match patterns it is derived from', () => {
    expect(GUBBINS_APP_URL_PATTERNS).toHaveLength(GUBBINS_APP_ORIGINS.length);
    for (const { scheme, host } of GUBBINS_APP_ORIGINS) {
      expect(isGubbinsAppUrl(`${scheme}://${host}${DEFAULT_BASE_PATH}`)).toBe(true);
    }
  });
});
