/**
 * Entry checksums for the backup container (issue #201).
 *
 * A backup's `manifest.json` records a digest of every other entry it wrote, so a restore can
 * prove the payload still matches what the backup *says* it contains. This catches accidental
 * damage — a truncated or partially-written entry, a zip repaired by another tool, a file
 * mangled by a sync client — which zip decoding alone does not: fflate's reader needs only the
 * end-of-central-directory record to succeed, and never verifies the per-entry CRC it stored.
 *
 * **This is damage detection, not tamper-proofing.** The digests live inside the same file they
 * describe, so anyone editing an entry can recompute them; the goal is to stop a *silently*
 * incomplete backup from restoring as if it were whole.
 *
 * CRC-32 (the same polynomial the zip format itself uses) is chosen because the codec is pure
 * and synchronous — `crypto.subtle` is async and would make the whole format layer, and every
 * call site through to the worker glue, async for no gain against a non-adversarial failure.
 */

/** The digest algorithm recorded in the manifest, so a future change stays readable both ways. */
export const CHECKSUM_ALGORITHM = 'crc32';

/** Lazily-built CRC-32 lookup table (reversed polynomial 0xEDB88320). */
const CRC_TABLE: Int32Array = (() => {
  const table = new Int32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let value = i;
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[i] = value;
  }
  return table;
})();

/**
 * CRC-32 of a byte range, as 8 lowercase hex digits. Pure and allocation-free, so hashing a
 * multi-megabyte `.sqlite` copy costs one pass over the bytes.
 */
export function checksumBytes(bytes: Uint8Array): string {
  let crc = -1;
  for (let i = 0; i < bytes.length; i += 1) {
    crc = CRC_TABLE[(crc ^ bytes[i]!) & 0xff]! ^ (crc >>> 8);
  }
  return ((crc ^ -1) >>> 0).toString(16).padStart(8, '0');
}
