/**
 * Humanising layer for transport failures (issue #634) — the network half of the seam that
 * `db-error-message.ts` covers for storage.
 *
 * `fetch` rejects with a bare `TypeError` when the request could not be made at all: no
 * connection, DNS failure, the host unreachable, a connection dropped mid-flight. Its message is
 * the browser's own untranslated diagnostic, and it is *browser-specific* — Chromium says
 * `Failed to fetch`, Firefox `NetworkError when attempting to fetch resource.`, Safari
 * `Load failed`. Left unclassified it reads as an authored sentence, so the Sync screen's
 * `role="alert"` shows machine text and the call site's written fallback is never reached.
 *
 * Like the database module this one is **pure** and catalog-free — it resolves an error to a
 * *message key*, never to text, and takes connectivity as an argument rather than reading
 * `navigator`. `useErrorMessage` binds it to `t()` and to `isOnline()`.
 *
 * The copy branches on connectivity because the two cases call for different actions: an offline
 * device needs to wait for signal, whereas an online device that cannot reach the remote is
 * looking at a service problem it can retry.
 *
 * **Not** classified here: `AbortError`. In this codebase an abort means a *deliberate*
 * cancellation — the file picker dismissed, a report cancelled, the scanner torn down — so
 * reporting it as a network problem would be actively wrong. Those call sites handle it
 * themselves (`save-file.ts`, `InsuranceScheduleScreen.tsx`).
 */

/** A resolved humanisation: the catalog key for the sentence shown to the user. */
export interface NetworkErrorDescription {
  /** Catalog key for the sentence shown to the user. */
  readonly key: string;
}

/**
 * The phrasings browsers use for "the request could not be made at all", lower-cased for
 * substring matching. Deliberately a closed list rather than "any `TypeError`": a `TypeError` can
 * equally be a genuine bug (`x is not a function`), and telling a user to check their connection
 * when the code is broken sends them somewhere there is nothing to find. An unrecognised phrasing
 * is not lost — `hasAuthoredMessage` rejects every `TypeError`, so it degrades to the call site's
 * own fallback copy rather than leaking.
 *
 * @internal Exported for unit tests only.
 */
export const TRANSPORT_FAILURE_MARKERS: readonly string[] = [
  'failed to fetch', // Chromium
  'networkerror when attempting to fetch resource', // Firefox
  'load failed', // Safari
  'the network connection was lost', // Safari
  'the internet connection appears to be offline', // Safari (iOS)
  'a server with the specified hostname could not be found', // Safari
  'network request failed', // older WebKit
];

/**
 * True when `error` is a `fetch` transport failure — the request never completed, so nothing was
 * sent or received. Gated on the `TypeError` name (which is what `fetch` rejects with) as well as
 * the phrasing, so an authored sentence that happens to contain one of the fragments — "The image
 * load failed." — is untouched.
 */
export function isTransportFailure(error: unknown): boolean {
  if (!(error instanceof Error) || error.name !== 'TypeError') return false;
  const text = error.message.trim().toLowerCase();
  return TRANSPORT_FAILURE_MARKERS.some((marker) => text.includes(marker));
}

/**
 * Describe `error` as a message key, or `undefined` when it is not a transport failure and the
 * caller's own fallback is the better copy.
 *
 * @param online Whether the device believes it has connectivity ({@link isOnline} at the call site).
 */
export function describeNetworkError(error: unknown, online: boolean): NetworkErrorDescription | undefined {
  if (!isTransportFailure(error)) return undefined;
  return { key: online ? 'network.error.unreachable' : 'network.error.offline' };
}
