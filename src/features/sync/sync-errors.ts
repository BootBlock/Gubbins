/**
 * Failures that mean *"the shared snapshot could not be read"* — as opposed to *"there is
 * no shared snapshot yet"* (issue #196).
 *
 * The distinction is load-bearing. `runSync` treats a `null` from
 * {@link CloudProvider.fetchSnapshot} as a first publish and **replaces** the shared copy
 * with this device's state. A provider that answers `null` for every failure therefore turns
 * a transient read problem — a cloud-drive placeholder that hasn't materialised, a locked or
 * half-written file, corrupt JSON — into a silent, successful-looking wipe of every record
 * that lived only on other devices.
 *
 * So a provider must only return `null` when the remote genuinely holds nothing, and raise
 * one of these otherwise. Both carry an authored, user-facing sentence: `describeError`
 * shows an `Error`'s own message when it doesn't read as raw SQLite output, so these reach
 * the user as written.
 */

/**
 * The remote exists but could not be read or understood — unreadable file, a read that
 * failed, or content that isn't a valid snapshot. Never a first publish: something *is*
 * there, so pushing over it would destroy it.
 */
export class SyncRemoteUnreadableError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'SyncRemoteUnreadableError';
  }
}

/**
 * The remote holds nothing, but this device has synced through it before — so the shared
 * copy has gone missing (wrong folder reconnected, file moved/trashed, cloud drive not yet
 * populated) rather than never having existed. Recoverable by the user: the sync screen
 * offers to publish this device's data as a new shared copy once they've confirmed that is
 * what they want (`RunSyncOptions.allowRemoteReset`).
 */
export class SyncRemoteMissingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SyncRemoteMissingError';
  }
}

/** Copy for {@link SyncRemoteUnreadableError}; shared so every provider says the same thing. */
export const REMOTE_UNREADABLE_MESSAGE =
  'The shared sync file is there but could not be read, so syncing stopped rather than risk ' +
  'replacing it with this device’s data. If your cloud drive is still downloading the file, ' +
  'wait for it to finish and try again.';

/** Copy for a remote whose content is present but not a readable snapshot. */
export const REMOTE_CORRUPT_MESSAGE =
  'The shared sync file could not be understood, so syncing stopped rather than replace it. ' +
  'It may still be part-written by another device — try again shortly. If it keeps failing, ' +
  'restore the folder from a backup or start a new shared copy.';

/** Copy for {@link SyncRemoteMissingError}. */
export const REMOTE_MISSING_MESSAGE =
  'This device has synced before, but the shared sync file is no longer there. Syncing stopped ' +
  'rather than replace it with only this device’s data — records that live on your other devices ' +
  'would be lost. Check the right folder or account is connected, then try again.';
