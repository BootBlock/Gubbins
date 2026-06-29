import { describe, it, expect, vi, beforeEach } from 'vitest';
import { GoogleDriveCloudProvider, makeDriveApi } from './google-drive-provider';
import { GoogleApiError } from './google-drive-api';
import { storeGoogleToken, clearGoogleToken } from './google-oauth';
import { snapshotToBackupJson } from '../backup';
import type { SyncSnapshot } from '../types';

const snapshot: SyncSnapshot = {
  formatVersion: 1,
  generatedAt: 1000,
  tables: { items: [{ id: 'i1', name: 'Widget' }] },
  tombstones: [],
  gaugeHistory: [],
  itemTags: [],
  itemHistory: [],
};

/**
 * A fake Drive backing one in-memory file, exercising the provider's find→read and
 * find→create/update paths through the real REST client shapes.
 */
function fakeDrive(initial: string | null = null) {
  let content = initial;
  let exists = initial !== null;
  const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    if (url.includes('uploadType=multipart') && method === 'POST') {
      content = bodyContent(String(init?.body));
      exists = true;
      return json({ id: 'file-1' });
    }
    if (url.includes('uploadType=media') && method === 'PATCH') {
      content = String(init?.body);
      return json({ id: 'file-1' });
    }
    if (url.includes('alt=media')) {
      return new Response(content ?? '', { status: 200 });
    }
    if (url.includes('drive/v3/files')) {
      return json({ files: exists ? [{ id: 'file-1' }] : [] });
    }
    return new Response('not found', { status: 404 });
  });
  return {
    api: { fetch: fetchImpl as unknown as typeof fetch, token: async () => 'ya29.TEST' },
    fetchImpl,
    peek: () => content,
  };
}

/** Extract the JSON content part from a multipart/related upload body. */
function bodyContent(body: string): string {
  const parts = body.split('\r\n\r\n');
  // metadata part, then the content part (which ends before the closing boundary).
  return parts[2]?.split('\r\n--')[0] ?? '';
}

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200 });
}

describe('GoogleDriveCloudProvider', () => {
  it('identifies itself for the handshake UI', () => {
    const { api } = fakeDrive();
    const provider = new GoogleDriveCloudProvider(api);
    expect(provider.id).toBe('google-drive');
    expect(provider.label).toBe('Google Drive');
  });

  it('has no server clock of its own (relies on the same-origin time fallback)', async () => {
    const { api } = fakeDrive();
    expect(await new GoogleDriveCloudProvider(api).getServerTime()).toBeNull();
  });

  it('returns null when the remote has no snapshot yet', async () => {
    const { api } = fakeDrive(null);
    expect(await new GoogleDriveCloudProvider(api).fetchSnapshot()).toBeNull();
  });

  it('round-trips a snapshot: push creates the file, fetch reads it back', async () => {
    const drive = fakeDrive(null);
    const provider = new GoogleDriveCloudProvider(drive.api);

    await provider.pushSnapshot(snapshot);
    expect(drive.peek()).toBe(snapshotToBackupJson(snapshot));

    const read = await provider.fetchSnapshot();
    expect(read).toEqual(snapshot);
  });

  it('updates the existing file on a subsequent push (no duplicate create)', async () => {
    const drive = fakeDrive(snapshotToBackupJson(snapshot));
    const provider = new GoogleDriveCloudProvider(drive.api);

    const updated: SyncSnapshot = { ...snapshot, generatedAt: 2000 };
    await provider.pushSnapshot(updated);

    // A PATCH (media update) was used, never a multipart create.
    const calls = drive.fetchImpl.mock.calls.map((c) => String(c[0]));
    expect(calls.some((u) => u.includes('uploadType=media'))).toBe(true);
    expect(calls.some((u) => u.includes('uploadType=multipart'))).toBe(false);
    expect(drive.peek()).toBe(snapshotToBackupJson(updated));
  });

  it('treats an empty remote file as no snapshot', async () => {
    const { api } = fakeDrive('   ');
    expect(await new GoogleDriveCloudProvider(api).fetchSnapshot()).toBeNull();
  });
});

describe('makeDriveApi token seam', () => {
  beforeEach(() => clearGoogleToken());

  it('supplies a live stored token', async () => {
    storeGoogleToken({ accessToken: 'ya29.LIVE', expiresAt: Date.now() + 3_600_000 });
    const api = makeDriveApi(vi.fn() as unknown as typeof fetch);
    expect(await api.token()).toBe('ya29.LIVE');
  });

  it('throws an auth error when the token is missing or expired', async () => {
    const api = makeDriveApi(vi.fn() as unknown as typeof fetch);
    await expect(api.token()).rejects.toBeInstanceOf(GoogleApiError);

    storeGoogleToken({ accessToken: 'ya29.OLD', expiresAt: Date.now() - 1000 });
    await expect(api.token()).rejects.toMatchObject({ isAuthError: true });
  });
});
