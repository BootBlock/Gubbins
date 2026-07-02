/**
 * Minimal Google Drive REST client for the sync snapshot (spec §7, Phase 7 cloud sync).
 *
 * Speaks the Drive v3 REST API directly with `fetch` — no Google SDK (§1.2, §2.4.3). The
 * whole sync payload is a single JSON file, {@link SNAPSHOT_NAME}, kept in the hidden,
 * app-private **`appDataFolder`** so Gubbins can neither see nor touch any of the user's
 * other Drive files. Every call carries a Bearer access token resolved through the
 * injected {@link DriveApi.token} seam, so this module is fully unit-testable with a fake
 * `fetch` and never imports the OAuth glue.
 */

/** The single file under `appDataFolder` that holds the whole sync snapshot. */
export const SNAPSHOT_NAME = 'gubbins-sync.json';

const DRIVE_FILES = 'https://www.googleapis.com/drive/v3/files';
const DRIVE_UPLOAD = 'https://www.googleapis.com/upload/drive/v3/files';

/** A Drive REST failure carrying the HTTP status (401 ⇒ re-auth needed). */
export class GoogleApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'GoogleApiError';
  }

  /** True when the token was rejected/expired and a fresh sign-in is required. */
  get isAuthError(): boolean {
    return this.status === 401;
  }
}

/** Injectable seam: a `fetch` plus a resolver for a currently-valid access token. */
export interface DriveApi {
  readonly fetch: typeof fetch;
  /** Resolve a valid access token, or throw {@link GoogleApiError}(401) when none is live. */
  readonly token: () => Promise<string>;
}

async function authedFetch(api: DriveApi, url: string, init: RequestInit = {}): Promise<Response> {
  const token = await api.token();
  const res = await api.fetch(url, {
    ...init,
    headers: { ...(init.headers as Record<string, string> | undefined), Authorization: `Bearer ${token}` },
  });
  if (res.status === 401) {
    throw new GoogleApiError(401, 'Google Drive sign-in has expired. Reconnect to continue syncing.');
  }
  if (!res.ok) {
    throw new GoogleApiError(res.status, `Google Drive request failed (HTTP ${res.status}).`);
  }
  return res;
}

/** Find the snapshot file's id under `appDataFolder`, or `null` when it doesn't exist yet. */
export async function findSnapshotFileId(api: DriveApi): Promise<string | null> {
  const params = new URLSearchParams({
    spaces: 'appDataFolder',
    q: `name='${SNAPSHOT_NAME}'`,
    fields: 'files(id)',
    pageSize: '1',
  });
  const res = await authedFetch(api, `${DRIVE_FILES}?${params.toString()}`);
  const json = (await res.json()) as { files?: { id?: string }[] };
  return json.files?.[0]?.id ?? null;
}

/** Read a file's raw text content (`alt=media`). */
export async function readSnapshotText(api: DriveApi, fileId: string): Promise<string> {
  const res = await authedFetch(api, `${DRIVE_FILES}/${encodeURIComponent(fileId)}?alt=media`);
  return res.text();
}

/**
 * Write the snapshot JSON, returning the file id. Creates the file (multipart upload,
 * parented into `appDataFolder`) when `fileId` is null, otherwise replaces its content
 * (media PATCH). The metadata is set once at creation, so updates ship content only.
 */
export async function writeSnapshot(api: DriveApi, fileId: string | null, content: string): Promise<string> {
  if (fileId) {
    const res = await authedFetch(
      api,
      `${DRIVE_UPLOAD}/${encodeURIComponent(fileId)}?uploadType=media&fields=id`,
      { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: content },
    );
    const json = (await res.json()) as { id?: string };
    return json.id ?? fileId;
  }

  const boundary = `gubbins-${crypto.randomUUID()}`;
  const metadata = JSON.stringify({ name: SNAPSHOT_NAME, parents: ['appDataFolder'] });
  const body =
    `--${boundary}\r\n` +
    'Content-Type: application/json; charset=UTF-8\r\n\r\n' +
    `${metadata}\r\n` +
    `--${boundary}\r\n` +
    'Content-Type: application/json\r\n\r\n' +
    `${content}\r\n` +
    `--${boundary}--`;
  const res = await authedFetch(api, `${DRIVE_UPLOAD}?uploadType=multipart&fields=id`, {
    method: 'POST',
    headers: { 'Content-Type': `multipart/related; boundary=${boundary}` },
    body,
  });
  const json = (await res.json()) as { id?: string };
  if (!json.id) throw new GoogleApiError(500, 'Google Drive did not return a file id on upload.');
  return json.id;
}
