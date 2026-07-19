import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  installStaleChunkRecovery,
  browserStaleChunkRecoveryApi,
  type StaleChunkRecoveryApi,
} from './stale-chunk-reload';
import { STALE_CHUNK_RELOAD_KEY } from './storage-keys';
import { APP_VERSION } from './app-version';

/**
 * Coverage for the stale-chunk recovery (#279): a tab left running an old build after another
 * tab applied an update finds its lazily-imported screens 404, and must reload itself onto the
 * current build — but not repeatedly on the *same* build, or a genuinely broken deploy would
 * spin the tab in a reload loop.
 */

/** A fake seam that records what the recovery did, with the marker held in memory. */
function fakeApi(alreadyRecovered = false) {
  let recovered = alreadyRecovered;
  const reload = vi.fn();
  const api: StaleChunkRecoveryApi = {
    hasRecovered: () => recovered,
    markRecovered: () => {
      recovered = true;
    },
    reload,
  };
  return { api, reload };
}

/** Dispatch the event Vite fires when a dynamic import's chunk cannot be fetched. */
function firePreloadError() {
  window.dispatchEvent(new Event('vite:preloadError', { cancelable: true }));
}

describe('installStaleChunkRecovery', () => {
  let teardown: (() => void) | undefined;

  afterEach(() => {
    teardown?.();
    teardown = undefined;
  });

  it('reloads the tab when a chunk fails to load', () => {
    const { api, reload } = fakeApi();
    teardown = installStaleChunkRecovery(api);

    firePreloadError();

    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('reloads only once, so a still-broken build cannot loop the tab', () => {
    const { api, reload } = fakeApi();
    teardown = installStaleChunkRecovery(api);

    firePreloadError();
    firePreloadError();
    firePreloadError();

    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('does not reload again when the running build is the one that already reloaded', () => {
    const { api, reload } = fakeApi(true);
    teardown = installStaleChunkRecovery(api);

    firePreloadError();

    expect(reload).not.toHaveBeenCalled();
  });

  it('leaves the event un-cancelled so the failed import still throws to the error boundary', () => {
    const { api } = fakeApi();
    teardown = installStaleChunkRecovery(api);

    const event = new Event('vite:preloadError', { cancelable: true });
    window.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(false);
  });

  it('stops listening once torn down', () => {
    const { api, reload } = fakeApi();
    installStaleChunkRecovery(api)();

    firePreloadError();

    expect(reload).not.toHaveBeenCalled();
  });
});

describe('browserStaleChunkRecoveryApi', () => {
  beforeEach(() => {
    sessionStorage.clear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    sessionStorage.clear();
  });

  it('records the running build in sessionStorage so the marker dies with the tab', () => {
    const api = browserStaleChunkRecoveryApi();

    expect(api.hasRecovered()).toBe(false);
    api.markRecovered();

    expect(api.hasRecovered()).toBe(true);
    expect(sessionStorage.getItem(STALE_CHUNK_RELOAD_KEY)).toBe(APP_VERSION);
  });

  it('lets a tab recover again once it is running a different build', () => {
    // The state after a *successful* recovery: the marker names the build we reloaded away from,
    // which is no longer the build running. A later update that strands this tab must recover too.
    sessionStorage.setItem(STALE_CHUNK_RELOAD_KEY, '0.0.1-some-older-build');

    expect(browserStaleChunkRecoveryApi().hasRecovered()).toBe(false);
  });

  it('reports "already recovered" when storage is unavailable, erring away from a loop', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('storage is blocked in this context');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('storage is blocked in this context');
    });
    const api = browserStaleChunkRecoveryApi();

    expect(() => api.markRecovered()).not.toThrow();
    expect(api.hasRecovered()).toBe(true);
  });
});
