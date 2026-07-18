/**
 * Guards the namespaced-storage-key registry (issue #378).
 *
 * The point of `storage-keys.ts` is that a new persisted store cannot quietly fall out of the
 * Danger Zone's erase catalog and the backup allow-list. That only holds if the registry is
 * *exhaustive*, so this test scans `src/` for `'gubbins:…'` string literals and fails when one
 * isn't registered — the same "make drift a build failure, not a review catch" posture as the
 * i18n catalog and `docs/todo/` banner guards.
 *
 * The scan matches a *complete* single-segment literal (`'gubbins:audit-session'`), which is
 * what a storage key looks like. That skips the scanner's `'gubbins:item:'` /
 * `'gubbins:location:'` prefixes (a trailing colon) and the `web+gubbins:` deep-link scheme.
 * The scraping parsers' `meta[name="gubbins:mpn"]` selectors need one extra exclusion — the
 * quoted attribute value *is* a complete literal by that definition — so a `name=` lookbehind
 * drops them: an HTML meta-tag name shares the namespace but is not a stored value.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { extname, join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ALL_STORAGE_KEYS, STORAGE_KEYS, backupIncludedKeys, eraseGroupKeys } from './storage-keys';

// Vitest runs from the project root; under happy-dom `import.meta.url` is an http: URL, not a
// file: one, so resolve against cwd (the same approach as the docs/todo guard).
const SRC_DIR = resolve(process.cwd(), 'src');

/** A whole string literal that is exactly one `gubbins:`-namespaced key (not a meta-tag name). */
const KEY_LITERAL = /(?<!name=)['"`](gubbins:[a-z0-9-]+)['"`]/g;

const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx']);

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

/** Every `gubbins:` key literal in the tree, mapped to the files mentioning it. */
function scanKeys(): Map<string, string[]> {
  const found = new Map<string, string[]>();
  for (const path of sourceFiles(SRC_DIR)) {
    const text = readFileSync(path, 'utf8');
    for (const match of text.matchAll(KEY_LITERAL)) {
      const key = match[1];
      const files = found.get(key) ?? [];
      files.push(relative(process.cwd(), path));
      found.set(key, files);
    }
  }
  return found;
}

const scanned = scanKeys();

describe('namespaced storage-key registry', () => {
  it('finds keys at all (guards against a silently-empty sweep)', () => {
    expect(scanned.size).toBeGreaterThan(10);
  });

  it('registers every `gubbins:` key used in the source tree', () => {
    const registered = new Set(ALL_STORAGE_KEYS);
    const unregistered = [...scanned.entries()].filter(([key]) => !registered.has(key));
    expect(
      unregistered.map(([key, files]) => `${key} (${files.join(', ')})`),
      'These keys are not in STORAGE_KEYS, so they are invisible to the erase catalog and the ' +
        'backup allow-list. Add an entry to src/lib/storage-keys.ts with an explicit eraseGroup ' +
        'and backupIncluded decision.',
    ).toEqual([]);
  });

  it('does not register a key that no longer exists in the source tree', () => {
    const stale = ALL_STORAGE_KEYS.filter((key) => !scanned.has(key));
    expect(stale, 'Registered keys with no remaining use — remove them from STORAGE_KEYS.').toEqual([]);
  });

  it('has no duplicate keys', () => {
    expect(new Set(ALL_STORAGE_KEYS).size).toBe(ALL_STORAGE_KEYS.length);
  });

  it('explains every exclusion, so a gap is always a decision rather than an oversight', () => {
    for (const entry of STORAGE_KEYS) {
      if (entry.eraseGroup === null || entry.storage !== 'local') {
        expect(entry.note, `${entry.key} needs a note explaining why it is excluded`).toBeTruthy();
      }
    }
  });

  it('never backs up or erases a key that is not in localStorage', () => {
    for (const entry of STORAGE_KEYS) {
      if (entry.storage === 'local') continue;
      expect(entry.backupIncluded, entry.key).toBe(false);
      expect(entry.eraseGroup, entry.key).toBeNull();
    }
  });

  it('pins the exact set of keys a portable backup may carry', () => {
    // Asserted exhaustively, not by exclusion: the allow-list now lives in this shared module
    // rather than inside the backup feature, so widening it must be a deliberate, reviewed
    // edit here — a stray `backupIncluded: true` on a device-specific or secret-bearing key
    // would otherwise silently start shipping it inside every backup file users share.
    expect(backupIncludedKeys()).toEqual(['gubbins:preferences', 'gubbins:layout', 'gubbins:saved-searches']);
  });

  it('keeps the device identity out of every selective erase', () => {
    // Clearing it would orphan locally-linked attachments; only a full reset may take it.
    expect(eraseGroupKeys('preferences')).not.toContain('gubbins:device-id');
    const grouped = STORAGE_KEYS.find((entry) => entry.key === 'gubbins:device-id');
    expect(grouped?.eraseGroup).toBeNull();
  });

  it('assigns each erase group at least one key', () => {
    const groups = new Set(
      STORAGE_KEYS.flatMap((entry) => (entry.eraseGroup === null ? [] : [entry.eraseGroup])),
    );
    for (const group of groups) {
      expect(eraseGroupKeys(group).length, group).toBeGreaterThan(0);
    }
  });

  it('would have every localStorage key swept by the hard reset prefix scan', () => {
    for (const entry of STORAGE_KEYS) {
      expect(entry.key.startsWith('gubbins:'), entry.key).toBe(true);
    }
  });
});
