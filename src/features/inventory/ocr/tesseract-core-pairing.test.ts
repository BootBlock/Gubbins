/**
 * Guards the `tesseract.js` ⇄ `tesseract.js-core` pairing (issue #185).
 *
 * On-device OCR is two packages that must move together: `tesseract.js` ships the Web Worker, and
 * `tesseract.js-core` ships the WASM cores the worker loads. `scripts/setup-ocr-assets.mjs` stages
 * both into `public/ocr/`, and the worker then requests a core **by filename** from our own origin
 * — so a core package that doesn't carry the variant the worker asks for is a runtime 404, not a
 * resolution error anything else would catch.
 *
 * That is not hypothetical. `npm outdated` reports the core as Current 7.0.0 / Latest 6.1.2: the
 * registry's `latest` dist-tag points *below* what we install, because upstream published core
 * 7.0.0 and then a 6.1.x patch for the Node-14 line minutes later (`npm publish` moves `latest` to
 * whatever it published last, regardless of semver order). Core 7 is where the relaxed-SIMD builds
 * live; 6.1.2 has no `tesseract-core-relaxedsimd*` files at all. "Correcting" the range down to the
 * registry's `latest` would therefore break OCR on every relaxed-SIMD-capable browser and nothing
 * else in the suite would notice.
 *
 * So assert the invariant rather than the version: the two packages share a major, that major is
 * the one the installed wrapper itself asks for, and the core really does contain every variant the
 * staged worker can select.
 */
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { repoPath } from '@/test/repo-path';

const require_ = createRequire(import.meta.url);

/** Resolve the directory an installed package's `package.json` sits in. */
function pkgDir(name: string): string {
  return dirname(require_.resolve(`${name}/package.json`));
}

// Read the repository files through `repoPath`, not cwd: a worktree's suite can be run from the
// primary checkout, and a cwd-relative guard would then check the *primary's* dependency ranges
// and variant list while the branch's own edits went unverified — green, and proving nothing.
const rootPkg = JSON.parse(readFileSync(repoPath(import.meta.dirname, 'package.json'), 'utf8')) as {
  dependencies: Record<string, string>;
};

const wrapperPkg = require_('tesseract.js/package.json') as {
  dependencies: Record<string, string>;
};

/** The major of a semver range or version — `^7.0.0` and `7.1.2` both give `7`. */
function major(range: string): number {
  const match = /(\d+)\.\d+\.\d+/.exec(range);
  if (!match) throw new Error(`no semver version found in "${range}"`);
  return Number(match[1]);
}

describe('tesseract.js ⇄ tesseract.js-core pairing', () => {
  it('declares both packages as direct dependencies', () => {
    // The core is a transitive dependency of the wrapper, but the staging script resolves it
    // directly, so it is declared directly too. Losing that declaration would make the script's
    // `require.resolve` depend on npm's hoisting rather than on our own dependency list.
    expect(Object.keys(rootPkg.dependencies)).toEqual(
      expect.arrayContaining(['tesseract.js', 'tesseract.js-core']),
    );
  });

  it('declares the same major for the wrapper and the core', () => {
    expect(major(rootPkg.dependencies['tesseract.js-core'])).toBe(
      major(rootPkg.dependencies['tesseract.js']),
    );
  });

  it('declares the core major the installed wrapper itself requires', () => {
    // This is the assertion that makes the dist-tag anomaly safe: our range tracks what
    // `tesseract.js` declares it needs, never what the registry happens to tag as `latest`.
    expect(major(rootPkg.dependencies['tesseract.js-core'])).toBe(
      major(wrapperPkg.dependencies['tesseract.js-core']),
    );
  });

  it('installs a core matching the declared major', () => {
    const { version } = require_('tesseract.js-core/package.json') as { version: string };
    expect(major(version)).toBe(major(rootPkg.dependencies['tesseract.js-core']));
  });
});

describe('staged core variants cover every one the worker can select', () => {
  /**
   * The variant base names the staged worker really references. Read from `worker.min.js` — the
   * exact bundle copied into `public/ocr/` — rather than the wrapper's `src/`, so this tracks the
   * artefact the browser runs even if upstream reorganises its sources.
   */
  const requested = [
    ...new Set(
      [
        ...readFileSync(resolve(pkgDir('tesseract.js'), 'dist/worker.min.js'), 'utf8').matchAll(
          // `[a-z0-9-]` rather than `[a-z-]`: a future variant with a digit in its name (say
          // `-simd128`) would otherwise be missing from *both* lists and the equality below
          // would stay green while the variant went unstaged.
          /tesseract-core[a-z0-9-]*(?=\.wasm\.js)/g,
        ),
      ].map((match) => match[0]),
    ),
  ].sort();

  /** The list `scripts/setup-ocr-assets.mjs` gates a published build on. */
  const declared = (() => {
    const script = readFileSync(repoPath(import.meta.dirname, 'scripts', 'setup-ocr-assets.mjs'), 'utf8');
    const block = /const CORE_VARIANTS = \[([^\]]*)\]/.exec(script);
    if (!block) throw new Error('CORE_VARIANTS not found in scripts/setup-ocr-assets.mjs');
    return [...block[1].matchAll(/'([^']+)'/g)].map((match) => match[1]).sort();
  })();

  it('finds the variants the worker requests', () => {
    // A worker bundle we can no longer read variant names out of must fail loudly rather than
    // silently reduce this whole file to a set of vacuous comparisons.
    expect(requested.length).toBeGreaterThanOrEqual(6);
    expect(requested).toContain('tesseract-core-relaxedsimd');
  });

  it('gates the published build on exactly those variants', () => {
    expect(declared).toEqual(requested);
  });

  it.each(requested.map((base) => [base] as const))('ships %s in the installed core package', (base) => {
    // `.wasm.js` is what the worker `importScripts`; the bare `.wasm` is for the Node/bundler
    // path. Both are staged, but only the former's absence breaks the browser.
    expect(existsSync(resolve(pkgDir('tesseract.js-core'), `${base}.wasm.js`))).toBe(true);
  });
});
