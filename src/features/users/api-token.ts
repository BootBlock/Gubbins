/**
 * Bridge API tokens — minting and hashing (issue #79, plan §1.3).
 *
 * A token is a **per-user credential for the Bridge**, replacing the single shared
 * `GUBBINS_BRIDGE_TOKEN` that used to grant everything to anyone holding it. The Bridge
 * resolves a presented token to the user who owns it, enforces that user's permissions on
 * every route, and attributes any write to them.
 *
 * Like `password.ts`, this module is deliberately free of React, `src/db` and all I/O: the
 * app mints tokens here and the Bridge verifies them here, so the two can never disagree
 * about the encoding. Node's strip-only loader also rules out `enum`, `namespace` and
 * parameter properties.
 *
 * ## Why SHA-256 and not PBKDF2
 *
 * Passwords are stretched with 600k PBKDF2 iterations because a human-chosen password is
 * guessable and the whole defence is making each guess expensive. Neither half of that
 * applies here:
 *
 * - A token is {@link API_TOKEN_BYTES} bytes of CSPRNG output — 256 bits. There is no
 *   dictionary, no reuse across sites and no pattern to exploit; brute-forcing the hash is
 *   infeasible regardless of how fast the hash is, so stretching buys nothing.
 * - The Bridge must resolve a token on **every request**. A 600k-iteration KDF in that path
 *   would cost hundreds of milliseconds per call — a self-inflicted denial of service, and
 *   a strong incentive to cache credentials somewhere worse.
 *
 * A fast hash over a high-entropy secret is the standard shape for API tokens for exactly
 * these reasons. What the hash *does* buy is that the stored form is not a usable credential:
 * the `api_tokens` rows travel in the sync snapshot (that is how they reach the Bridge at
 * all), and a snapshot sitting in a shared folder must not hand out Bridge access.
 *
 * The plaintext exists only in the instant it is minted. It is shown once, never stored, and
 * cannot be recovered — a lost token is replaced, not looked up.
 */

/**
 * Human-recognisable prefix on every token, so one found in a config file or a log is
 * identifiable as a Gubbins credential (and greppable by secret scanners) without having to
 * guess what it belongs to.
 */
export const API_TOKEN_PREFIX = 'gbn_';

/** Entropy in bytes. 32 → 256 bits, encoded as 64 hex characters. */
export const API_TOKEN_BYTES = 32;

/**
 * How many characters of a token — prefix included — are kept in the clear as
 * `api_tokens.token_prefix`, purely so the management list can show *which* token a row is.
 *
 * Short by design: it identifies a row, it does not narrow the secret. Ten characters leaves
 * six hex digits (24 bits) exposed out of 256, so the remaining search space is unchanged in
 * any way that matters.
 */
export const API_TOKEN_DISPLAY_CHARS = 10;

/** The minimal Web-Crypto randomness surface, injectable so minting is deterministic in tests. */
export interface RandomSource {
  getRandomValues<T extends ArrayBufferView>(array: T): T;
}

/**
 * A freshly minted token: the plaintext to show the operator **once**, plus the two values
 * that are actually persisted. Kept together in one return so a caller cannot store a hash
 * that does not correspond to the token it just displayed.
 */
export interface MintedApiToken {
  /** The token itself. Show it once, then discard it — it is never recoverable. */
  readonly token: string;
  /** Lowercase hex SHA-256 of {@link token}; what `api_tokens.token_hash` holds. */
  readonly hash: string;
  /** The leading {@link API_TOKEN_DISPLAY_CHARS} characters; what `api_tokens.token_prefix` holds. */
  readonly prefix: string;
}

/**
 * Generate a token string: {@link API_TOKEN_PREFIX} followed by {@link API_TOKEN_BYTES}
 * bytes of randomness in lowercase hex.
 */
export function generateApiToken(random: RandomSource = globalThis.crypto): string {
  const bytes = random.getRandomValues(new Uint8Array(API_TOKEN_BYTES));
  let hex = '';
  for (const byte of bytes) hex += byte.toString(16).padStart(2, '0');
  return `${API_TOKEN_PREFIX}${hex}`;
}

/**
 * Lowercase hex SHA-256 of `token` — the stored form, and the value a presented token is
 * looked up by. Trims first so a token pasted with stray whitespace still resolves; that is
 * the difference between "it doesn't work and I can't see why" and it simply working.
 */
export async function hashApiToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token.trim()));
  let hex = '';
  for (const byte of new Uint8Array(digest)) hex += byte.toString(16).padStart(2, '0');
  return hex;
}

/** The non-secret leading fragment of `token` kept for display. See {@link API_TOKEN_DISPLAY_CHARS}. */
export function apiTokenDisplayPrefix(token: string): string {
  return token.trim().slice(0, API_TOKEN_DISPLAY_CHARS);
}

/**
 * Mint a new token, returning the plaintext alongside the two values to persist. The caller
 * shows {@link MintedApiToken.token} once and stores the rest.
 */
export async function mintApiToken(random: RandomSource = globalThis.crypto): Promise<MintedApiToken> {
  const token = generateApiToken(random);
  return { token, hash: await hashApiToken(token), prefix: apiTokenDisplayPrefix(token) };
}
