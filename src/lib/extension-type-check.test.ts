/**
 * Guards the gate that puts a TypeScript compiler behind the browser extension (issue #557).
 *
 * `extension/build.mjs` bundles the extension's entry points with Vite in **library mode**, which
 * strips types without checking them, and the directory sits in no tsconfig the app's `tsc -b`
 * builds. So until `extension/tsconfig.json` existed, the extension was the only TypeScript in
 * the repository with nothing type-checking it — and it had accumulated six real errors, one of
 * which voided the typing on the message the privileged background worker dispatches on.
 *
 * The exposure is the shared source: each entry point imports the app's real
 * `src/features/scraping/**` modules — the parsers, the error taxonomy, and the allow-list gate
 * that stops the worker becoming a fetch proxy for an arbitrary origin. Change one of those
 * signatures while working in `src/` and, without this gate, every check stays green until
 * somebody loads the unpacked extension.
 *
 * Two things have to hold for that gate to keep working, and neither is visible at a call site:
 * `npm run type-check` must actually run the extension's config, and that config must actually
 * cover the files the build bundles. Both are asserted here.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { repoPath } from '../test/repo-path';

// Resolved from *this file's* checkout, never `process.cwd()` — see `repoPath`.
const read = (...segments: string[]) => readFileSync(repoPath(import.meta.dirname, ...segments), 'utf8');

const scripts = (JSON.parse(read('package.json')) as { scripts: Record<string, string> }).scripts;

describe('the extension type-check gate', () => {
  it('is reachable from the aggregate `type-check` script', () => {
    // The aggregate is what CI's quality job, CONTRIBUTING.md and the PR checklist all invoke.
    // An extension-only script nobody runs would be no gate at all.
    expect(scripts['type-check']).toContain('type-check:extension');
    expect(scripts['type-check:extension']).toBe('tsc --noEmit -p extension/tsconfig.json');
  });

  it('runs before a push whenever the app, the bridge or the extension changes', () => {
    // The pre-push hook is the local half of the same gate — this repository pushes straight to
    // `main` with no branch protection, so a red CI run blocks nothing on its own.
    const hook = read('.githooks', 'pre-push');
    expect(hook).toContain('^(src|bridge|extension)/');
    expect(hook).toContain('npm run --silent type-check:extension');
  });

  it('covers every entry point the extension build bundles', () => {
    // `include` is a glob over `extension/src`, so a new entry point is covered automatically —
    // but only while the build keeps putting its entry points there. One moved up a directory
    // would bundle happily and be type-checked by nothing.
    const config = read('extension', 'tsconfig.json');
    expect(config).toContain('"src/**/*.ts"');

    const entries = [...read('extension', 'build.mjs').matchAll(/^await bundle\('([^']+)'/gm)].map(
      (match) => match[1],
    );
    expect(entries.length).toBeGreaterThan(0);
    for (const entry of entries) {
      expect(entry).toMatch(/^src\/.+\.ts$/);
    }
  });
});
