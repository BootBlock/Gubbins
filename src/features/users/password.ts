/**
 * Password hashing and verification (issue #79, plan §1.1).
 *
 * **Read the limitation before changing anything here.** Gubbins is a backend-less local PWA:
 * the SQLite database sits on the device and is readable by anyone holding it. A password
 * therefore cannot protect the data at rest, and this module does not pretend otherwise — it
 * gates the UI and attributes actions to a person. Strengthening the KDF does not change that,
 * and no amount of work here would; encryption at rest is explicitly out of scope (a lost
 * password would mean permanent data loss, and the key would have to reach sync and the
 * Bridge).
 *
 * What it *is* good for: a household member cannot idly open the audit log or act as someone
 * else, and a hash that leaks with a backup is not trivially reversible.
 *
 * PBKDF2-HMAC-SHA-256 via WebCrypto, with a per-user random salt and the iteration count
 * stored **alongside each hash** rather than as a global constant. That is what lets the count
 * be raised later without invalidating existing passwords: an old hash keeps verifying at its
 * own count, and is re-hashed at the current one next time it is successfully used.
 *
 * No `src/db` import and no React — the Bridge may need to verify a password in a later phase,
 * and Node's strip-only loader also rules out `enum`, `namespace` and parameter properties.
 */

/**
 * Iterations for a newly-set password. OWASP's floor for PBKDF2-HMAC-SHA-256 at time of
 * writing; deliberately a *starting* value, since {@link PasswordCredential.iterations} records
 * what each hash actually used.
 */
export const PASSWORD_ITERATIONS = 600_000;

/** Salt length in bytes. 16 is the usual PBKDF2 recommendation and is plenty here. */
const SALT_BYTES = 16;

/** Derived key length in bits, matching SHA-256's output. */
const DERIVED_BITS = 256;

/**
 * The stored form of a password: the three columns that live on a `users` row. All three are
 * NULL together for a user with no password, which is a legitimate configuration (plan §1.1)
 * — the database enforces that all-or-nothing rule with a CHECK.
 */
export interface PasswordCredential {
  readonly hash: string;
  readonly salt: string;
  readonly iterations: number;
}

/** Base64-encode bytes. */
function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/** Decode base64 back to bytes. Returns an empty array for anything malformed. */
function fromBase64(value: string): Uint8Array {
  try {
    const binary = atob(value);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  } catch {
    // A corrupt or hand-edited salt must fail verification, not throw into the sign-in screen.
    return new Uint8Array(0);
  }
}

/** Derive the PBKDF2 bits for `password` against `salt`, as base64. */
async function derive(password: string, salt: Uint8Array, iterations: number): Promise<string> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, [
    'deriveBits',
  ]);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt: salt as BufferSource, iterations },
    key,
    DERIVED_BITS,
  );
  return toBase64(new Uint8Array(bits));
}

/**
 * Hash `password` for storage, minting a fresh random salt.
 *
 * Throws on an empty password: "no password" is represented by the credential being absent
 * altogether, never by a hash of the empty string. Allowing both would mean two encodings of
 * the same state, and the weaker one would silently satisfy a password prompt.
 */
export async function hashPassword(
  password: string,
  iterations: number = PASSWORD_ITERATIONS,
): Promise<PasswordCredential> {
  if (password.length === 0) {
    throw new Error('A password cannot be empty. Clear the password instead to leave a user with none.');
  }
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  return { hash: await derive(password, salt, iterations), salt: toBase64(salt), iterations };
}

/**
 * Whether `password` matches `credential`.
 *
 * Compares in constant time with respect to the *stored* hash. That is cheap insurance rather
 * than a meaningful defence here — an attacker who can time this already has the database —
 * but a variable-time compare in an auth path is the kind of thing that gets copied somewhere
 * it does matter.
 */
export async function verifyPassword(password: string, credential: PasswordCredential): Promise<boolean> {
  if (password.length === 0) return false;
  if (!Number.isInteger(credential.iterations) || credential.iterations <= 0) return false;

  const salt = fromBase64(credential.salt);
  if (salt.length === 0) return false;

  const derived = await derive(password, salt, credential.iterations);
  return timingSafeEqual(derived, credential.hash);
}

/**
 * Whether a credential should be re-hashed after a successful sign-in — i.e. it was created at
 * a lower iteration count than the one this build uses. Re-hashing is only ever safe at that
 * moment, because it is the only time the plaintext is in hand.
 */
export function needsRehash(credential: PasswordCredential): boolean {
  return credential.iterations < PASSWORD_ITERATIONS;
}

/** Length-aware constant-time string comparison. */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let difference = 0;
  for (let i = 0; i < a.length; i++) difference |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return difference === 0;
}
