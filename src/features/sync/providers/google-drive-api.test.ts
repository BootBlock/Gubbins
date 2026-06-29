import { describe, it, expect, vi } from 'vitest';
import {
  findSnapshotFileId,
  readSnapshotText,
  writeSnapshot,
  GoogleApiError,
  type DriveApi,
} from './google-drive-api';

/** A fake DriveApi whose `fetch` is a vi.fn returning queued Responses. */
function fakeApi(fetchImpl: typeof fetch, token = 'ya29.TEST'): DriveApi {
  return { fetch: fetchImpl, token: async () => token };
}

function jsonResponse(body: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
    ...init,
  });
}

describe('findSnapshotFileId', () => {
  it('queries the appDataFolder space and returns the first match id', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ files: [{ id: 'file-1' }] }));
    const id = await findSnapshotFileId(fakeApi(fetchImpl));
    expect(id).toBe('file-1');

    const [url, init] = fetchImpl.mock.calls[0];
    expect(String(url)).toContain('spaces=appDataFolder');
    expect(String(url)).toContain('drive/v3/files');
    // The query is scoped to the snapshot file name.
    expect(decodeURIComponent(String(url))).toContain("name='gubbins-sync.json'");
    // Bearer auth attached.
    expect((init?.headers as Record<string, string>).Authorization).toBe('Bearer ya29.TEST');
  });

  it('returns null when the remote has no snapshot yet', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ files: [] }));
    expect(await findSnapshotFileId(fakeApi(fetchImpl))).toBeNull();
  });

  it('throws an auth error on 401', async () => {
    const fetchImpl = vi.fn(async () => new Response('no', { status: 401 }));
    await expect(findSnapshotFileId(fakeApi(fetchImpl))).rejects.toMatchObject({
      status: 401,
      isAuthError: true,
    });
  });

  it('throws a GoogleApiError on other failures', async () => {
    const fetchImpl = vi.fn(async () => new Response('boom', { status: 500 }));
    await expect(findSnapshotFileId(fakeApi(fetchImpl))).rejects.toBeInstanceOf(GoogleApiError);
  });
});

describe('readSnapshotText', () => {
  it('reads file media as text', async () => {
    const fetchImpl = vi.fn(async () => new Response('{"hello":1}', { status: 200 }));
    const text = await readSnapshotText(fakeApi(fetchImpl), 'file-1');
    expect(text).toBe('{"hello":1}');
    expect(String(fetchImpl.mock.calls[0][0])).toContain('files/file-1?alt=media');
  });
});

describe('writeSnapshot', () => {
  it('creates a new file via multipart upload when no id exists', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ id: 'new-file' }));
    const id = await writeSnapshot(fakeApi(fetchImpl), null, '{"a":1}');
    expect(id).toBe('new-file');

    const [url, init] = fetchImpl.mock.calls[0];
    expect(String(url)).toContain('uploadType=multipart');
    expect(init?.method).toBe('POST');
    const contentType = (init?.headers as Record<string, string>)['Content-Type'];
    expect(contentType).toMatch(/^multipart\/related; boundary=/);
    // The multipart body names the file and parents it into the appDataFolder.
    expect(String(init?.body)).toContain('gubbins-sync.json');
    expect(String(init?.body)).toContain('appDataFolder');
    expect(String(init?.body)).toContain('{"a":1}');
  });

  it('updates an existing file via a media PATCH', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ id: 'file-1' }));
    const id = await writeSnapshot(fakeApi(fetchImpl), 'file-1', '{"b":2}');
    expect(id).toBe('file-1');

    const [url, init] = fetchImpl.mock.calls[0];
    expect(String(url)).toContain('files/file-1');
    expect(String(url)).toContain('uploadType=media');
    expect(init?.method).toBe('PATCH');
    expect(String(init?.body)).toBe('{"b":2}');
  });
});
