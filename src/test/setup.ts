/**
 * Global Vitest setup (referenced by `test.setupFiles` in vite.config.ts).
 *
 * Extends `expect` with the Testing Library DOM matchers (e.g. `toBeInTheDocument`)
 * for the component-level tests of the Tier-1 state layer described in spec §8.5.
 */
import '@testing-library/jest-dom/vitest';
import { configure } from '@testing-library/react';
import { ASYNC_UTIL_TIMEOUT_MS } from '../../vitest.timeouts';

// Testing Library's 1s retry budget is too tight under load; see `vitest.timeouts.ts`.
configure({ asyncUtilTimeout: ASYNC_UTIL_TIMEOUT_MS });

/*
 * Ensure a working Web Storage API for Tier-2 (Zustand `persist`) stores under test.
 * The Node test runtime can expose an experimental `localStorage` global that lacks a
 * usable `setItem` (it warns `--localstorage-file was provided without a valid path`),
 * which shadows happy-dom's. Install a tiny in-memory stub when the present one is
 * unusable so persisted-store setters don't throw during unit tests.
 */
if (typeof globalThis.localStorage?.setItem !== 'function') {
  const store = new Map<string, string>();
  const stub: Storage = {
    get length() {
      return store.size;
    },
    clear: () => store.clear(),
    getItem: (key) => (store.has(key) ? store.get(key)! : null),
    key: (index) => [...store.keys()][index] ?? null,
    removeItem: (key) => void store.delete(key),
    setItem: (key, value) => void store.set(key, String(value)),
  };
  Object.defineProperty(globalThis, 'localStorage', { value: stub, configurable: true });
}
