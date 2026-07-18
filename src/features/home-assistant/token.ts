/**
 * Bridge access-token generation for the Home Assistant setup guide.
 *
 * The Gubbins bridge authenticates every request with a shared bearer token
 * (`GUBBINS_BRIDGE_TOKEN`). The README tells users to make one with
 * `node -e "…randomBytes(32).toString('hex')"`, but a user following the in-app guide may
 * not have a terminal handy — so the guide can mint a cryptographically strong token for
 * them right here, in the browser, using the Web Crypto API. This module is the pure,
 * transport-free core: it only produces the string; the React step wires up copy-to-clipboard
 * and the optional "save to this device" convenience.
 *
 * The randomness source is injectable so the generator is deterministic under test; in the
 * app it defaults to the global `crypto` (Web Crypto), which is a CSPRNG in every browser
 * Gubbins targets.
 */

/** The minimal Web-Crypto surface the generator needs — injectable for tests. */
export interface RandomSource {
  getRandomValues<T extends ArrayBufferView>(array: T): T;
}

/**
 * Default entropy in bytes. 32 bytes → 256 bits → a 64-character hex string.
 *
 * @internal Exported for unit tests only.
 */
export const DEFAULT_TOKEN_BYTES = 32;

/**
 * Guard rails so a bad caller can't ask for a trivially weak or absurdly large token.
 *
 * @internal Exported for unit tests only.
 */
export const MIN_TOKEN_BYTES = 16;
/** @internal Exported for unit tests only. */
export const MAX_TOKEN_BYTES = 64;

/**
 * Generate a random bearer token as a lowercase hex string.
 *
 * `bytes` is the amount of entropy (clamped to `[MIN, MAX]`); the returned string is twice
 * as long (two hex chars per byte). Pass a fake {@link RandomSource} in tests for a
 * deterministic result.
 */
export function generateBridgeToken(
  bytes: number = DEFAULT_TOKEN_BYTES,
  random: RandomSource = globalThis.crypto,
): string {
  const size = clampBytes(bytes);
  const buffer = new Uint8Array(size);
  random.getRandomValues(buffer);
  return toHex(buffer);
}

/**
 * Clamp a requested byte count to the supported range, rounding to a whole number.
 *
 * @internal Exported for unit tests only.
 */
export function clampBytes(bytes: number): number {
  if (!Number.isFinite(bytes)) return DEFAULT_TOKEN_BYTES;
  return Math.min(MAX_TOKEN_BYTES, Math.max(MIN_TOKEN_BYTES, Math.round(bytes)));
}

/** Lowercase, zero-padded hex encoding of a byte buffer (no dependencies). */
function toHex(bytes: Uint8Array): string {
  let out = '';
  for (const byte of bytes) out += byte.toString(16).padStart(2, '0');
  return out;
}
