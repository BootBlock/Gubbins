/**
 * `lastSyncedAt` is a *per-connection* record, not a device-global one (issue #196).
 *
 * The sync screen reads it to tell "the shared copy has gone missing" apart from "this remote
 * is simply new" — the engine's own guard keys off `sync_meta`, which survives a provider
 * switch and so cannot answer that question. If it leaked across a reconnect to a different
 * folder or account, connecting a fresh remote would be reported as a lost one.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { useAuthStore } from './useAuthStore';

describe('useAuthStore.setProvider', () => {
  beforeEach(() => {
    useAuthStore.getState().disconnect();
  });

  it('keeps lastSyncedAt when the same remote is reconnected', () => {
    const { setProvider, markSynced } = useAuthStore.getState();
    setProvider('file-system', 'Local folder · Sync');
    markSynced(1000);
    // e.g. re-granting folder permission after a reload.
    useAuthStore.getState().setProvider('file-system', 'Local folder · Sync');
    expect(useAuthStore.getState().lastSyncedAt).toBe(1000);
  });

  it('clears lastSyncedAt when a different folder is connected', () => {
    const { setProvider, markSynced } = useAuthStore.getState();
    setProvider('file-system', 'Local folder · Sync');
    markSynced(1000);
    useAuthStore.getState().setProvider('file-system', 'Local folder · Other');
    expect(useAuthStore.getState().lastSyncedAt).toBeNull();
  });

  it('clears lastSyncedAt when a different provider is connected', () => {
    const { setProvider, markSynced } = useAuthStore.getState();
    setProvider('file-system', 'Local folder · Sync');
    markSynced(1000);
    useAuthStore.getState().setProvider('google-drive', 'Google Drive');
    expect(useAuthStore.getState().lastSyncedAt).toBeNull();
  });

  it('disconnect clears the whole handshake', () => {
    const { setProvider, markSynced } = useAuthStore.getState();
    setProvider('memory', 'In-memory (test) provider');
    markSynced(1000);
    useAuthStore.getState().disconnect();
    expect(useAuthStore.getState()).toMatchObject({
      providerId: null,
      providerLabel: null,
      connectedAt: null,
      lastSyncedAt: null,
    });
  });
});
