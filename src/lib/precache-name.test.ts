import { describe, it, expect } from 'vitest';
import {
  precacheCacheName,
  precacheRequestSpec,
  isPrecacheName,
  PRECACHE_PREFIX,
  type PrecacheEntry,
} from './precache-name';

/**
 * Issue #499. The precache used to be a constant name every build shared, so an *installing*
 * build wrote its shell and chunks into the cache the *active* worker was serving from — after
 * which a plain refresh silently took an update the user had never accepted, reset warning and
 * all. The fix is structural: the name is derived from the build's own asset manifest, so two
 * builds cannot collide on one cache.
 *
 * These lock the two properties the worker's correctness rests on — a different build derives a
 * different name, an identical build derives the same one — plus the per-entry HTTP-cache mode
 * that keeps a stale `index.html` out of a fresh precache.
 */

/** A plausible two-entry manifest: the unhashed shell, plus one content-hashed chunk. */
const MANIFEST: readonly PrecacheEntry[] = [
  { url: 'index.html', revision: 'a1b2c3d4' },
  { url: 'assets/index-9f8e7d6c.js', revision: null },
];

describe('precacheCacheName', () => {
  it('names a cache under the shared precache prefix', () => {
    const name = precacheCacheName(MANIFEST);
    expect(name.startsWith(PRECACHE_PREFIX)).toBe(true);
    expect(isPrecacheName(name)).toBe(true);
  });

  it('derives the same name for the same manifest, so an unchanged build reuses its cache', () => {
    expect(precacheCacheName(MANIFEST)).toBe(precacheCacheName([...MANIFEST]));
  });

  it('derives a different name when a hashed asset URL changes', () => {
    const next: PrecacheEntry[] = [MANIFEST[0]!, { url: 'assets/index-00112233.js', revision: null }];
    expect(precacheCacheName(next)).not.toBe(precacheCacheName(MANIFEST));
  });

  it('derives a different name when only the shell revision changes', () => {
    // The shell keeps a stable URL and carries its content hash in `revision`, so a fingerprint
    // over URLs alone would hand a shell-only change the previous build's cache — which is the
    // install-into-the-live-cache bug wearing a different hat.
    const next: PrecacheEntry[] = [{ url: 'index.html', revision: 'ffffffff' }, MANIFEST[1]!];
    expect(precacheCacheName(next)).not.toBe(precacheCacheName(MANIFEST));
  });

  it('derives a different name when an asset is added', () => {
    const next: PrecacheEntry[] = [...MANIFEST, { url: 'icons/icon-192.png', revision: '00ff00ff' }];
    expect(precacheCacheName(next)).not.toBe(precacheCacheName(MANIFEST));
  });

  it('recognises the retired constant name as one of its own precaches', () => {
    // The build shipping this fix must still sweep the cache every previous build wrote to.
    expect(isPrecacheName('gubbins-precache-v1')).toBe(true);
    expect(isPrecacheName('gubbins-ocr-assets-7.0.0')).toBe(false);
    expect(isPrecacheName('gubbins-bridge-origin-v1')).toBe(false);
  });
});

describe('precacheRequestSpec', () => {
  const SCOPE = 'https://app.example.test/Gubbins/sw.js';

  it('resolves a manifest URL against the worker scope, so cache keys are absolute', () => {
    expect(precacheRequestSpec(MANIFEST[1]!, SCOPE).url).toBe(
      'https://app.example.test/Gubbins/assets/index-9f8e7d6c.js',
    );
  });

  it('bypasses the HTTP cache for an unhashed entry, so a stale shell cannot be precached', () => {
    // GitHub Pages serves HTML with a finite `max-age`; without this, an update installing inside
    // that window precaches the *previous* shell beside this build's chunks.
    expect(precacheRequestSpec(MANIFEST[0]!, SCOPE).cache).toBe('reload');
  });

  it('lets a content-hashed entry come from the HTTP cache', () => {
    // The URL is the content hash, so a cached copy cannot be the wrong bytes — forcing a
    // re-download would just re-fetch megabytes of identical WASM and chunks on every update.
    expect(precacheRequestSpec(MANIFEST[1]!, SCOPE).cache).toBe('default');
  });
});
