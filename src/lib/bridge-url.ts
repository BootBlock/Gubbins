/**
 * Bridge base-URL handling — the one place a user-entered bridge address is validated.
 *
 * Two features now call the optional Home Assistant bridge from the browser: "push to bridge"
 * (`features/sync/push-to-bridge`) and the scale reading behind "count by weight"
 * (`features/inventory/scale-reading`, issue #122). They share this helper so a URL that is
 * accepted by one is accepted by the other, and so the wording of a rejection never drifts
 * between two screens describing the same field.
 *
 * Side-effect-free (no fetch, no React) so it is unit-tested directly.
 */

/**
 * Trim a user-entered bridge base URL and validate its scheme, returning it without a trailing
 * slash so a path can be appended cleanly. Throws a friendly, user-facing error on a blank or
 * non-HTTP(S) value — these strings are shown verbatim in the UI.
 */
export function normaliseBridgeBaseUrl(baseUrl: string): string {
  const trimmed = baseUrl.trim().replace(/\/+$/, '');
  if (trimmed === '') throw new Error('Enter the bridge URL, e.g. http://127.0.0.1:8787.');
  if (!/^https?:\/\//i.test(trimmed)) {
    throw new Error('The bridge URL must start with http:// or https://.');
  }
  return trimmed;
}

/** Join a validated bridge base URL with an absolute API path (e.g. `/api/v1/scale/entities`). */
export function resolveBridgeUrl(baseUrl: string, path: string): string {
  return `${normaliseBridgeBaseUrl(baseUrl)}${path}`;
}
