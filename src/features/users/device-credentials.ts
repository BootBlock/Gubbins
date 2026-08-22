/**
 * Forgetting the credentials a device holds on behalf of whoever is signed in (issue #521).
 *
 * Bridge API tokens are per-user, but the app stores exactly one on the device. Nothing about
 * signing out used to touch it, so on a shared tablet the next person inherited the previous
 * person's credential — and a token is *portable*: it is plain text in `localStorage`, it never
 * expires, and it authenticates the bridge's write endpoints and MCP tools as the person who
 * pasted it, from any machine on the network. That is a different thing from the permission
 * model's deliberate soft boundary at the device, and it also quietly defeated per-user tokens:
 * the bridge attributed every write to whoever last configured the device.
 *
 * So signing out drops this device's portable credentials. What is deliberately *not* dropped:
 *
 *  - **The bridge address** (`bridgeUrl`) — an address on the network, not a secret, and the
 *    next person needs it to enter a token of their own.
 *  - **The sync folder handle** (the `gubbins-fs` IndexedDB store) — a File System Access handle
 *    cannot be lifted off the device and used elsewhere, so it grants nothing beyond the physical
 *    access the person already has. The Danger Zone's "Sync links" target clears it on request.
 *
 * Sign-out is only reachable when the Users module is on, so a single-user install keeps its
 * bridge token exactly as before. The Danger Zone's "Bridge access token" target is the
 * single-user route to the same thing.
 */
import { clearGoogleToken } from '@/features/sync/providers/google-oauth';
import { resetPreferenceFields } from '@/state/stores/usePreferencesStore';

/** The preference fields that hold a credential rather than a setting. */
const CREDENTIAL_PREF_FIELDS: readonly string[] = ['bridgeToken'];

/**
 * Drop every portable credential this device is holding. Best-effort: one store refusing must not
 * leave the rest resident, because a half-cleared device is the case this exists to prevent.
 */
export function forgetDeviceCredentials(): void {
  try {
    resetPreferenceFields(CREDENTIAL_PREF_FIELDS);
  } catch {
    // Storage full or unavailable — carry on and still drop the cloud token below.
  }
  try {
    clearGoogleToken();
  } catch {
    // As above: a refusal here must not strand the bridge token that was just cleared.
  }
}
