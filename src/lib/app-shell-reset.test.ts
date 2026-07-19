/**
 * `resetAppShell` — the data-preserving escape hatch from a bad build (issue #276).
 *
 * The whole point of this function is what it *doesn't* touch. Before it existed, the only
 * in-app way to get a clean service worker was the hard reset, which also deleted the OPFS
 * database, the images directory and every `gubbins:` key — so a cosmetic bug cost a user
 * their entire inventory. These tests pin that boundary, and pin that neither step can be
 * blocked by the other failing.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { resetAppShell } from './app-shell-reset';

/** Install a fake `caches` and `navigator.serviceWorker`, returning the unregister spies. */
function stubBrowser(options: { cacheKeys?: string[]; registrations?: number } = {}) {
  const unregister = vi.fn().mockResolvedValue(true);
  const registrations = Array.from({ length: options.registrations ?? 0 }, () => ({ unregister }));
  const del = vi.fn().mockResolvedValue(true);

  vi.stubGlobal('caches', { keys: vi.fn().mockResolvedValue(options.cacheKeys ?? []), delete: del });
  vi.stubGlobal('navigator', {
    serviceWorker: { getRegistrations: vi.fn().mockResolvedValue(registrations) },
  });

  return { unregister, del };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('resetAppShell', () => {
  it('unregisters every worker and deletes every cache', async () => {
    const { unregister, del } = stubBrowser({ cacheKeys: ['shell-v1', 'share-inbox'], registrations: 2 });

    const result = await resetAppShell();

    expect(unregister).toHaveBeenCalledTimes(2);
    expect(del).toHaveBeenCalledWith('shell-v1');
    expect(del).toHaveBeenCalledWith('share-inbox');
    expect(result).toEqual({ workersUnregistered: 2, cachesDeleted: 2 });
  });

  it('leaves user data alone — no OPFS, IndexedDB or localStorage access', async () => {
    stubBrowser({ cacheKeys: ['shell-v1'], registrations: 1 });
    const getDirectory = vi.fn();
    const deleteDatabase = vi.fn();
    const removeItem = vi.fn();
    const clear = vi.fn();
    vi.stubGlobal('indexedDB', { deleteDatabase });
    vi.stubGlobal('localStorage', { length: 0, key: vi.fn(), removeItem, clear });
    // Re-stub navigator with storage attached so an OPFS reach would succeed if attempted.
    vi.stubGlobal('navigator', {
      serviceWorker: { getRegistrations: vi.fn().mockResolvedValue([]) },
      storage: { getDirectory },
    });

    await resetAppShell();

    expect(getDirectory).not.toHaveBeenCalled();
    expect(deleteDatabase).not.toHaveBeenCalled();
    expect(removeItem).not.toHaveBeenCalled();
    expect(clear).not.toHaveBeenCalled();
  });

  it('still clears caches when service workers are unavailable', async () => {
    const del = vi.fn().mockResolvedValue(true);
    vi.stubGlobal('caches', { keys: vi.fn().mockResolvedValue(['shell-v1']), delete: del });
    vi.stubGlobal('navigator', {});

    await expect(resetAppShell()).resolves.toEqual({ workersUnregistered: 0, cachesDeleted: 1 });
    expect(del).toHaveBeenCalledWith('shell-v1');
  });

  it('still unregisters workers when Cache Storage throws', async () => {
    const unregister = vi.fn().mockResolvedValue(true);
    vi.stubGlobal('caches', {
      keys: vi.fn().mockRejectedValue(new Error('Cache Storage disabled')),
    });
    vi.stubGlobal('navigator', {
      serviceWorker: { getRegistrations: vi.fn().mockResolvedValue([{ unregister }]) },
    });

    await expect(resetAppShell()).resolves.toEqual({ workersUnregistered: 1, cachesDeleted: 0 });
    expect(unregister).toHaveBeenCalledOnce();
  });

  it('reports nothing done rather than throwing when both APIs are missing', async () => {
    vi.stubGlobal('caches', undefined);
    vi.stubGlobal('navigator', {});

    await expect(resetAppShell()).resolves.toEqual({ workersUnregistered: 0, cachesDeleted: 0 });
  });
});
