import { beforeEach, describe, expect, it } from 'vitest';
import { forgetDeviceCredentials } from './device-credentials';
import { loadGoogleToken, storeGoogleToken } from '@/features/sync/providers/google-oauth';
import { usePreferencesStore } from '@/state/stores/usePreferencesStore';

const state = () => usePreferencesStore.getState();

describe('forgetDeviceCredentials (issue #521)', () => {
  beforeEach(() => {
    localStorage.clear();
    usePreferencesStore.setState(usePreferencesStore.getInitialState(), true);
  });

  it('drops the bridge token so the next person cannot act as the last one', () => {
    state().setBridgeToken('example-bridge-token');

    forgetDeviceCredentials();

    expect(state().bridgeToken).toBe('');
  });

  it('drops the cloud access token too', () => {
    storeGoogleToken({ accessToken: 'example-drive-token', expiresAt: Date.now() + 3_600_000 });

    forgetDeviceCredentials();

    expect(loadGoogleToken()).toBeNull();
  });

  it('keeps the bridge address, which is not a secret and is what the next person needs', () => {
    state().setBridgeUrl('http://127.0.0.1:8787');
    state().setBridgeToken('example-bridge-token');

    forgetDeviceCredentials();

    expect(state().bridgeUrl).toBe('http://127.0.0.1:8787');
  });

  it('leaves the persisted blob without the token, not merely the live store', () => {
    state().setBridgeToken('example-bridge-token');

    forgetDeviceCredentials();

    // The store re-persists on every set, so the write that clears the field is what removes it
    // from storage as well — the two must never disagree.
    const raw = localStorage.getItem('gubbins:preferences');
    expect(raw).not.toBeNull();
    expect(JSON.parse(raw as string).state.bridgeToken).toBe('');
  });
});
