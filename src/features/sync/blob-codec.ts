/**
 * Base64 BLOB codec for the sync/backup payload (spec §4.2, Phase 11).
 *
 * `item_images.thumbnail_blob` is a small BLOB (a tiny WebP). The §4.2.1 Anti-Base64
 * Directive keeps *full-resolution* bytes out of the DB and out of sync (they stay as
 * OPFS files), but the lightweight thumbnail must travel so a peer can render lists
 * without the original. A `SyncSnapshot` has to survive `JSON.stringify` (the cloud
 * doc and the manual Export/Import are both JSON), where a raw `Uint8Array` would
 * serialise to a useless `{ "0": …, "1": … }` object — so thumbnails are base64-encoded
 * in the snapshot and decoded back to bytes only when written to the database.
 *
 * Encoding mirrors the Safe-Mode export (`app/error/safe-mode-actions.ts`).
 */

/** Encode raw bytes to a base64 string (snapshot-side). */
export function encodeBlob(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/** Decode a base64 string back to raw bytes (DB-write-side). */
export function decodeBlob(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/**
 * Encode a row's `thumbnail_blob` to base64 for the snapshot (no-op when already a
 * string/null). Returns a new row; never mutates the input.
 */
export function encodeThumbnail(row: Record<string, unknown>): Record<string, unknown> {
  const thumb = row.thumbnail_blob;
  if (thumb instanceof Uint8Array) return { ...row, thumbnail_blob: encodeBlob(thumb) };
  return row;
}

/**
 * Decode a row's base64 `thumbnail_blob` back to bytes for a DB write (no-op when null
 * or already bytes). Returns a new row; never mutates the input.
 */
export function decodeThumbnail(row: Record<string, unknown>): Record<string, unknown> {
  const thumb = row.thumbnail_blob;
  if (typeof thumb === 'string') return { ...row, thumbnail_blob: decodeBlob(thumb) };
  return row;
}

/** Tables carrying a BLOB column that needs base64 transcoding in the snapshot. */
const BLOB_TABLES = new Set<string>(['item_images']);

/** Table-aware encode for the snapshot read side (bytes → base64). */
export function encodeRowForTable<T extends Record<string, unknown>>(table: string, row: T): T {
  return BLOB_TABLES.has(table) ? (encodeThumbnail(row) as T) : row;
}

/** Table-aware decode for the DB write side (base64 → bytes). */
export function decodeRowForTable<T extends Record<string, unknown>>(table: string, row: T): T {
  return BLOB_TABLES.has(table) ? (decodeThumbnail(row) as T) : row;
}
