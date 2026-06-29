/**
 * Google Drive {@link CloudProvider} adapter (spec §1.2, §7, Phase 7 cloud sync).
 *
 * The real cloud transport the provider-agnostic engine was built for: it stores the
 * merged {@link SyncSnapshot} as one JSON file in Drive's app-private `appDataFolder`, so
 * two devices signed into the same Google account reconcile through it — no SDK (§1.2),
 * no backend. It composes the pure {@link google-drive-api} REST client with a token seam
 * backed by the OAuth handling in {@link google-oauth}; the snapshot (de)serialisation is
 * the same `backup` codec the File System provider and manual export/import use, so a
 * Drive sync doc *is* a restorable backup.
 *
 * Connect/reconnect/forget mirror the File System provider's shape so the SyncScreen wires
 * them identically. Because the implicit OAuth flow uses a top-level redirect,
 * {@link connectGoogleDrive} navigates away and resumes via the app-entry handler; the
 * live token (and thus "connected" state) is recovered on the next load by
 * {@link reconnectGoogleDrive}.
 */
import type { CloudProvider } from '../provider';
import { parseBackupJson, snapshotToBackupJson } from '../backup';
import type { SyncSnapshot } from '../types';
import {
  findSnapshotFileId,
  readSnapshotText,
  writeSnapshot,
  GoogleApiError,
  type DriveApi,
} from './google-drive-api';
import { beginGoogleAuth, clearGoogleToken, loadGoogleToken, tokenValid } from './google-oauth';

export class GoogleDriveCloudProvider implements CloudProvider {
  readonly id = 'google-drive';
  readonly label = 'Google Drive';

  /** Cached snapshot file id, resolved lazily and reused across a session's calls. */
  private fileId: string | null = null;

  constructor(private readonly api: DriveApi) {}

  /**
   * Drive's `Date` response header is not CORS-exposed to a browser, so the provider has
   * no readable server clock; the engine falls back to the same-origin {@link httpTimeSource}
   * (§7.3 "a lightweight reliable time server *or* the cloud provider's API header").
   */
  async getServerTime(): Promise<number | null> {
    return null;
  }

  async fetchSnapshot(): Promise<SyncSnapshot | null> {
    const id = await findSnapshotFileId(this.api);
    this.fileId = id;
    if (!id) return null;
    const text = await readSnapshotText(this.api, id);
    if (text.trim().length === 0) return null;
    return parseBackupJson(text);
  }

  async pushSnapshot(snapshot: SyncSnapshot): Promise<void> {
    // Resolve the file id once (a fresh provider that hasn't fetched yet must look first,
    // so a first push updates an existing remote file rather than creating a duplicate).
    if (this.fileId === null) this.fileId = await findSnapshotFileId(this.api);
    this.fileId = await writeSnapshot(this.api, this.fileId, snapshotToBackupJson(snapshot));
  }
}

/**
 * Build a {@link DriveApi} whose token resolver reads the device-local stored token and
 * rejects (as a 401-class {@link GoogleApiError}) when none is live — so an expired session
 * surfaces as the same "reconnect" path as a server-rejected token.
 */
export function makeDriveApi(fetchImpl: typeof fetch = fetch): DriveApi {
  return {
    fetch: fetchImpl,
    token: async () => {
      const token = loadGoogleToken();
      if (!tokenValid(token, Date.now())) {
        throw new GoogleApiError(401, 'Not signed in to Google Drive. Reconnect to sync.');
      }
      return token!.accessToken;
    },
  };
}

/** Start the Google sign-in redirect (must be called from a user gesture; navigates away). */
export function connectGoogleDrive(): void {
  beginGoogleAuth();
}

export interface GoogleReconnect {
  /** A ready provider when a live token is stored, else null. */
  readonly provider: GoogleDriveCloudProvider | null;
  /** True when the user previously used Google Drive but the token is gone/expired. */
  readonly needsAuth: boolean;
}

/**
 * Resume Google Drive from a stored token. With a live token it returns a ready provider;
 * otherwise `needsAuth` tells the UI to offer a "Reconnect Google Drive" sign-in. `intended`
 * (the persisted provider id was `google-drive`) keeps `needsAuth` false for a user who
 * never chose Google, so the reconnect prompt only shows when it is actually relevant.
 */
export function reconnectGoogleDrive(intended: boolean): GoogleReconnect {
  const token = loadGoogleToken();
  if (tokenValid(token, Date.now())) {
    return { provider: new GoogleDriveCloudProvider(makeDriveApi()), needsAuth: false };
  }
  return { provider: null, needsAuth: intended };
}

/** Forget the stored Google token (on explicit disconnect). */
export function forgetGoogleDrive(): void {
  clearGoogleToken();
}
