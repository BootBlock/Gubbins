/**
 * Deterministic, name-based UUIDs (RFC 4122 §4.3 version-5, SHA-1).
 *
 * A version-4 `crypto.randomUUID()` is the right identity for a *new* thing minted once.
 * It is the wrong identity for the artefact of a **one-shot terminal operation** two devices
 * can each run offline before they sync — finalising a project's assembly is the acute case
 * (issue #195): both devices mint a fresh id, and the merge keeps both, leaving the user with
 * two identical containers or two copies of the assembled object. A name-based UUID fixes this
 * at the root: derived purely from stable inputs (here, the project id), both devices compute
 * the *same* id, so the two writes collapse to one by last-writer-wins — the same convergence
 * trick the `item_relations` (`from|to|kind`) and `item_stock` (`item|location`) natural keys
 * already use, but yielding a real UUID so QR labels (`scan-payload.ts` requires a valid UUID)
 * and every id-shaped assumption still hold.
 *
 * The result is a canonical lower-case v5 UUID and is stable across devices, runs and platforms
 * for the same `(namespace, name)`. `crypto.subtle` is available in every context this runs in
 * (secure-context main thread, the database worker, Node for the bridge and tests).
 */

/** Parse a canonical UUID string into its 16 raw bytes. */
function uuidToBytes(uuid: string): Uint8Array {
  const hex = uuid.replace(/-/g, '');
  const bytes = new Uint8Array(16);
  for (let i = 0; i < 16; i += 1) {
    bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

/** Format 16 raw bytes as a canonical lower-case UUID string. */
function bytesToUuid(bytes: Uint8Array): string {
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

/**
 * Compute the RFC 4122 version-5 (name-based, SHA-1) UUID for `name` within `namespace`.
 *
 * `namespace` is a canonical UUID string identifying the naming authority; `name` is any
 * string. The same pair always yields the same UUID. Deterministic and side-effect-free.
 */
export async function uuidv5(name: string, namespace: string): Promise<string> {
  const namespaceBytes = uuidToBytes(namespace);
  const nameBytes = new TextEncoder().encode(name);
  const input = new Uint8Array(namespaceBytes.length + nameBytes.length);
  input.set(namespaceBytes, 0);
  input.set(nameBytes, namespaceBytes.length);

  const digest = new Uint8Array(await crypto.subtle.digest('SHA-1', input));
  const bytes = digest.slice(0, 16); // SHA-1 is 20 bytes; the first 16 become the UUID.
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x50; // version 5
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80; // RFC 4122 variant
  return bytesToUuid(bytes);
}
