/**
 * Who a ledger clear is recorded against (issue #620) — the pure half of the Activity Log's
 * Clear control.
 *
 * A cleared log keeps one entry saying it was cleared, and that entry has to say *by whom* or
 * it records only that evidence went missing. With the users module on, that is the signed-in
 * person. With it off — Gubbins' default, where there is no account to name — the honest answer
 * is the **device**: this is a local-first app with no server in the path, so there is no client
 * IP to record, and a device id is the only stable marker of "which of my machines did this".
 *
 * The id is shortened because the label is read, not resolved: eight hex characters distinguish
 * one of a handful of household devices at a glance, where a full UUID would only be noise. It
 * identifies a browser profile, never a person, and it is already device-local (never synced),
 * so nothing here reveals more than the device that did the clearing.
 */

/** How much of the device id the marker shows — enough to tell devices apart, no more. */
const DEVICE_MARKER_LENGTH = 8;

/**
 * The label to record for whoever ordered a clear: the signed-in user's display name, or a
 * short device marker when nobody is signed in. Never empty, so the note always names someone.
 */
export function clearedByLabel(displayName: string | null | undefined, deviceId: string): string {
  const name = displayName?.trim();
  if (name) return name;
  return `device ${deviceId.slice(0, DEVICE_MARKER_LENGTH)}`;
}
