/**
 * Guards the persisted stores' version/migration story (issue #372).
 *
 * A `persist(...)` store that declares only a `name` is pinned at version 0 with nowhere to hang
 * a migration, so the first real shape change has to be written retroactively — against installs
 * whose localStorage already holds the old shape. Every store therefore declares a `version`.
 *
 * It must declare a `migrate` alongside it, and that pairing is the sharp edge this test really
 * protects: zustand only calls `migrate` when the stored version differs from the declared one,
 * and with **no** `migrate` it logs an error and hydrates the store with `undefined` — bumping a
 * version bare silently *discards* the user's persisted state. So a `version` without a `migrate`
 * is data loss, not a warning, and fails here rather than in review.
 *
 * The scan is textual (the same posture as the `gubbins:`-key registry and `docs/todo/` banner
 * guards): it finds source files that build a persisted store and checks the options each one
 * declares. Every such file holds exactly one store today; a file growing a second one would need
 * this counting made per-store rather than per-file.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { extname, join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// Vitest runs from the project root; under happy-dom `import.meta.url` is an http: URL, not a
// file: one, so resolve against cwd (the same approach as the storage-key guard).
const SRC_DIR = resolve(process.cwd(), 'src');

const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx']);

/** The `name:` of a persisted store's options object — what marks the file as holding one. */
const STORE_NAME = /\bname:\s*['"`](gubbins:[a-z0-9-]+)['"`]/g;

/** Every non-test source file under `src/`, recursively. */
function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...sourceFiles(path));
    } else if (SOURCE_EXTENSIONS.has(extname(entry.name)) && !/\.test\.tsx?$/.test(entry.name)) {
      out.push(path);
    }
  }
  return out;
}

interface PersistedStoreFile {
  readonly file: string;
  readonly storeNames: readonly string[];
  readonly hasVersion: boolean;
  readonly hasMigrate: boolean;
}

/** Every source file that builds a `persist(...)` store, with the options it declares. */
function persistedStoreFiles(): PersistedStoreFile[] {
  const out: PersistedStoreFile[] = [];
  for (const path of sourceFiles(SRC_DIR)) {
    const text = readFileSync(path, 'utf8');
    if (!text.includes("from 'zustand/middleware'") || !text.includes('persist(')) continue;
    const storeNames = [...text.matchAll(STORE_NAME)].map((match) => match[1]);
    if (storeNames.length === 0) continue;
    out.push({
      file: relative(process.cwd(), path).replace(/\\/g, '/'),
      storeNames,
      hasVersion: /\bversion:\s*\d+/.test(text),
      hasMigrate: /\bmigrate:/.test(text),
    });
  }
  return out;
}

describe('persisted store versions', () => {
  const stores = persistedStoreFiles();

  it('finds the persisted stores to check', () => {
    // A refactor that moves or renames the persist call sites must not silently empty the scan.
    expect(stores.length).toBeGreaterThanOrEqual(14);
  });

  it.each(stores.map((store) => [`${store.file} (${store.storeNames.join(', ')})`, store] as const))(
    '%s declares a version and a migrate',
    (_label, store) => {
      expect({ version: store.hasVersion, migrate: store.hasMigrate }).toEqual({
        version: true,
        migrate: true,
      });
    },
  );
});
