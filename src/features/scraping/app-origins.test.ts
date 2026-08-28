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
import {
  GUBBINS_APP_ORIGINS,
  GUBBINS_APP_URL_PATTERNS,
  isGubbinsAppUrl,
  matchesAppOrigin,
  type AppOrigin,
} from './app-origins';

// Resolved from *this file's* checkout, never `process.cwd()` — see `repoPath`.
const manifestPath = repoPath(import.meta.dirname, 'extension', 'manifest.json');
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
  content_scripts?: { matches?: string[]; js?: string[] }[];
};

const extensionSource = (name: string): string =>
  readFileSync(repoPath(import.meta.dirname, 'extension', 'src', name), 'utf8');

describe('extension content_scripts.matches (§9.1 injection surface)', () => {
  const matches = manifest.content_scripts?.[0]?.matches ?? [];

  it('matches the single source of truth exactly', () => {
    expect(matches).toEqual([...GUBBINS_APP_URL_PATTERNS]);
  });

  it('never injects by host wildcard, and pins each pattern to its origin’s own base path', () => {
    // `https://*.github.io/*` is every GitHub Pages site on the internet; `http://localhost/*`
    // is every dev server on the machine, because a match pattern cannot pin a port. Asserted
    // over a list first proven non-empty, so an absent `matches` cannot pass by vacuity. The
    // path is checked against *its own* entry rather than one global base path, so a
    // self-hoster who adds their deployment (see `extension/README.md`) does not have to edit
    // this guard to follow the recipe.
    expect(matches.length).toBeGreaterThan(0);
    matches.forEach((pattern, i) => {
      expect(pattern).not.toContain('*.');
      expect(pattern).not.toContain('<all_urls>');
      const origin = GUBBINS_APP_ORIGINS[i];
      expect(origin, `no origin entry for pattern ${pattern}`).toBeDefined();
      expect(pattern).toBe(`${origin!.scheme}://${origin!.host}${origin!.path}*`);
    });
  });

  it('ships exactly the three documented origins, each under the app’s base path', () => {
    // The real guard on the shipped build: the loop above proves each pattern agrees with its
    // entry, but an entry widened at source (`{ host: 'localhost', path: '/' }`) would agree with
    // itself perfectly well and re-open issue #493. Pinning the whole list makes any widening a
    // deliberate, visible edit. A self-hoster adding their own deployment updates this list too —
    // `extension/README.md` says so, and their entry then reads as the choice it is.
    expect(GUBBINS_APP_ORIGINS).toEqual([
      { scheme: 'https', host: 'bootblock.github.io', path: DEFAULT_BASE_PATH },
      { scheme: 'http', host: 'localhost', path: DEFAULT_BASE_PATH },
      { scheme: 'http', host: '127.0.0.1', path: DEFAULT_BASE_PATH },
    ]);
  });

  it('injects only the content script, and only on the documented origins', () => {
    expect(manifest.content_scripts).toHaveLength(1);
    expect(manifest.content_scripts?.[0]?.js).toEqual(['content-script.js']);
    expect(matches).toContain('https://bootblock.github.io/Gubbins/*');
  });
});

describe('the checks that back the manifest up (§9.1 defence-in-depth)', () => {
  // The extension halves have no runtime harness — no test can drive an MV3 worker — so the
  // guards that keep a widened manifest from re-opening issue #493 would otherwise be deletable
  // with the suite still green. These read the source: coarse, but they fail the moment the
  // check they name stops existing, which is the regression worth catching.

  it('has the content script refuse to install itself anywhere but the app', () => {
    expect(extensionSource('content-script.ts')).toContain(
      'if (isGubbinsAppUrl(window.location.href)) install();',
    );
  });

  it('has the worker refuse a fetch, a lookup and a data fetch from any other sender', () => {
    const worker = extensionSource('background.ts');
    expect(worker).toContain('const fromApp = isAppSender(sender);');
    // The three request kinds are narrowed to one `BackgroundRequest` before the sender is
    // checked, so they share a single refusal — which has to come BEFORE the dispatch, or a
    // foreign page's request would be served on its way to being refused.
    const dispatch = worker.slice(worker.indexOf('const request = asBackgroundRequest(bag);'));
    expect(dispatch).not.toBe('');
    const refusal = dispatch.indexOf('if (!fromApp) {');
    expect(refusal).toBeGreaterThan(-1);
    for (const kind of ['FETCH', 'LOOKUP', 'DATA_FETCH']) {
      const dispatched = dispatch.indexOf(`case '${kind}':`);
      expect(dispatched).toBeGreaterThan(-1);
      expect(refusal).toBeLessThan(dispatched);
    }
    // The queue flush that hands over a captured payload keeps its own check.
    expect(worker).toContain("bag?.kind === 'PWA_READY'");
    expect(worker).toContain('&& fromApp');
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

  it('accepts every origin the match patterns name, and each pattern names its own path', () => {
    for (const { scheme, host, path } of GUBBINS_APP_ORIGINS) {
      expect(isGubbinsAppUrl(`${scheme}://${host}${path}`)).toBe(true);
      expect(GUBBINS_APP_URL_PATTERNS).toContain(`${scheme}://${host}${path}*`);
    }
  });

  it('normalises a hand-written entry, so a missing slash cannot reopen the prefix hole', () => {
    // Both cases are what a self-hoster following `extension/README.md` plausibly writes. An
    // un-normalised `/gubbins` would admit `/gubbins-evil/`, and an upper-case host would inject
    // and then fail the predicate — an extension that is loaded and silently inert.
    const loose: AppOrigin = { scheme: 'https', host: 'Gubbins.Example.Test', path: '/gubbins' };
    const origins = [loose];
    expect(matchesAppOrigin('https://gubbins.example.test/gubbins/items/1', origins)).toBe(true);
    expect(matchesAppOrigin('https://gubbins.example.test/gubbins-evil/', origins)).toBe(false);
  });

  it('carries the base path per origin, so a self-hoster can add one served at the root', () => {
    // The self-hosting recipe in `extension/README.md` turns on this: a Docker deployment serves
    // the app at the domain root, so an entry that could only ever mean `/Gubbins/` would leave
    // that user with no working edit to make.
    const selfHosted: AppOrigin = { scheme: 'https', host: 'gubbins.example.test', path: '/' };
    const origins = [...GUBBINS_APP_ORIGINS, selfHosted];
    expect(matchesAppOrigin('https://gubbins.example.test/items/1', origins)).toBe(true);
    // Their entry admits their deployment and nothing else — not a neighbouring host, and not a
    // sibling project on one of the shipped origins.
    expect(matchesAppOrigin('https://other.example.test/items/1', origins)).toBe(false);
    expect(matchesAppOrigin('https://bootblock.github.io/other-project/', origins)).toBe(false);
    // And it is absent from the shipped list, so the shipped build still refuses it.
    expect(isGubbinsAppUrl('https://gubbins.example.test/items/1')).toBe(false);
  });
});
