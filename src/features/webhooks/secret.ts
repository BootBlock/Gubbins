/**
 * Generating an in-row signing secret (webhooks plan `W7`; see §6.1).
 *
 * The UI steers to `secret_ref` — a *name* pointing at a value held in the bridge's own config,
 * which never enters the database, the sync artefact, or any backup. The in-row `secret` is the
 * convenience fallback, and it travels in the sync artefact in plaintext.
 *
 * Where the user takes that fallback, the value is **generated here rather than invented by them**.
 * That is the whole point of this module: a hand-typed signing secret is chosen for memorability,
 * and a memorable HMAC key is a weak one. Generating it also makes "show it once, then offer
 * regenerate only" honest — there is nothing the user needs to remember, so there is no reason to
 * ever display it again.
 */

/**
 * Bytes of entropy in a generated secret. 32 bytes (256 bits) matches the HMAC-SHA256 block the
 * bridge signs with, so the key is never the weak part of the signature.
 */
export const WEBHOOK_SECRET_BYTES = 32;

/**
 * Generate a signing secret as lower-case hex.
 *
 * Uses the Web Crypto CSPRNG. `Math.random` is emphatically not an option — it is not
 * cryptographically secure, and this value is what authenticates every payload the bridge sends.
 */
export function generateWebhookSecret(
  randomBytes: (length: number) => Uint8Array = defaultRandomBytes,
): string {
  const bytes = randomBytes(WEBHOOK_SECRET_BYTES);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function defaultRandomBytes(length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return bytes;
}
