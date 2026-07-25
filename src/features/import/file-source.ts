/**
 * The shared "picked file → import text" seam (issue #347).
 *
 * Every importer ingress — the item importer's file tab, the BOM and purchase-list uploads, and
 * the OS file-handler launch — hands its `File` here instead of calling `file.text()` /
 * `FileReader.readAsText` itself. A file input's `accept` attribute is advisory (the picker's
 * "All files" option defeats it, and so does a drag-and-drop), so the *content* is what decides:
 *
 *  - **Size** is read from `file.size` before a single byte is loaded, so a 100 MB selection is
 *    refused rather than read, decoded, parsed and planned on the main thread.
 *  - **Binary** input is refused — by signature for the common wrong picks (a spreadsheet
 *    workbook, a PDF, a photo), and otherwise by the control bytes no text file carries. Left
 *    unchecked, decoding binary yields a string of replacement characters that the free-form
 *    parser happily turns into one junk item per line.
 *  - **Encoding** is decoded strictly rather than assumed: UTF-8, and UTF-16 when a byte-order
 *    mark says so. A file that is *not* valid UTF-8 falls back to Windows-1252 and reports that
 *    it did, so a Latin-1 export (still common from older systems) lands with its accented
 *    characters intact instead of silently corrupted cell by cell.
 *
 * The decoding half is pure — bytes in, text or a reason out — so it unit-tests under Node;
 * only {@link readImportFile} touches the `File` API. Callers render the outcome through
 * `ImportFileBanner` so every importer explains a refusal in the same words.
 */

/**
 * Hard ceiling on a picked import file. Expressed base-1000 to match how browsers and operating
 * systems report a file's size, so a refusal quotes the same figure the user sees in their file
 * manager. The whole file is decoded, parsed and previewed on the main thread, so this cap is
 * what keeps that work bounded; it is still far above any real inventory export (16 MB is on the
 * order of 80,000 CSV rows).
 */
export const MAX_IMPORT_FILE_BYTES = 16_000_000;

/** The text encodings an import can be read as. */
export type ImportFileEncoding = 'utf-8' | 'utf-16le' | 'utf-16be' | 'windows-1252';

/**
 * What a refused file appears to be. Coarse on purpose: enough for the message to name the thing
 * the user picked and suggest the way round it (save it as CSV, extract the archive), not a
 * general-purpose type detector.
 */
export type BinaryFileKind = 'package' | 'legacyOffice' | 'pdf' | 'image' | 'archive' | 'unknown';

/** Why a picked file cannot become import text. */
export type ImportFileRejection =
  | { readonly reason: 'empty' }
  | { readonly reason: 'tooLarge'; readonly bytes: number; readonly limitBytes: number }
  | { readonly reason: 'binary'; readonly kind: BinaryFileKind }
  | { readonly reason: 'unreadable' };

/** A file read either yields text (naming the encoding it was read as) or a reason it did not. */
export type ImportFileRead =
  | { readonly ok: true; readonly text: string; readonly encoding: ImportFileEncoding }
  | { readonly ok: false; readonly rejection: ImportFileRejection };

/**
 * Leading-byte signatures for the files users actually pick by mistake. Only signatures that no
 * plausible text file could start with are listed — `BM` (bitmap) and `MZ` (executable) are
 * deliberately absent because a CSV may legitimately begin with those letters; both are riddled
 * with NUL bytes, so the control-byte check below catches them anyway.
 */
const BINARY_SIGNATURES: readonly { readonly signature: readonly number[]; readonly kind: BinaryFileKind }[] =
  [
    // Zip container — .xlsx / .ods / .docx / .numbers / .zip, the most common wrong pick of all.
    { signature: [0x50, 0x4b, 0x03, 0x04], kind: 'package' },
    { signature: [0x50, 0x4b, 0x05, 0x06], kind: 'package' },
    { signature: [0x50, 0x4b, 0x07, 0x08], kind: 'package' },
    // OLE2 compound file — the pre-zip .xls / .doc formats.
    { signature: [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1], kind: 'legacyOffice' },
    { signature: [0x25, 0x50, 0x44, 0x46, 0x2d], kind: 'pdf' }, // "%PDF-"
    { signature: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], kind: 'image' }, // PNG
    { signature: [0xff, 0xd8, 0xff], kind: 'image' }, // JPEG
    { signature: [0x47, 0x49, 0x46, 0x38], kind: 'image' }, // "GIF8" — 87a and 89a
    { signature: [0x1f, 0x8b], kind: 'archive' }, // gzip
    { signature: [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c], kind: 'archive' }, // 7z
    { signature: [0x52, 0x61, 0x72, 0x21, 0x1a, 0x07], kind: 'archive' }, // "Rar!"
  ];

/** How much of the input the binary checks look at — enough to judge, cheap on a large file. */
const SNIFF_SAMPLE = 64 * 1024;

/**
 * The share of sampled characters that may be control characters before the input is treated as
 * binary rather than text. Not zero: a stray control character in an otherwise fine export should
 * not cost the user their import.
 */
const MAX_CONTROL_SHARE = 0.02;

/** Control bytes/characters a plain-text export legitimately contains. */
function isTextControl(code: number): boolean {
  return code === 0x09 || code === 0x0a || code === 0x0d || code === 0x0c;
}

function startsWith(bytes: Uint8Array, signature: readonly number[]): boolean {
  return bytes.length >= signature.length && signature.every((byte, i) => bytes[i] === byte);
}

/** The four bytes at `offset` read as ASCII, for box-header style signatures. */
function ascii4(bytes: Uint8Array, offset: number): string {
  return bytes.length >= offset + 4 ? String.fromCharCode(...bytes.subarray(offset, offset + 4)) : '';
}

/**
 * What the bytes look like if they are not text at all, or `null` when nothing says binary.
 * Not called for UTF-16 input (which is half NUL bytes by construction and is identified by its
 * byte-order mark instead) — {@link looksLikeText} covers that path after decoding.
 */
function sniffBinaryKind(bytes: Uint8Array): BinaryFileKind | null {
  for (const { signature, kind } of BINARY_SIGNATURES) {
    if (startsWith(bytes, signature)) return kind;
  }
  // ISO base-media container: a box length, then "ftyp" — a HEIC photo or an MP4 / MOV video.
  if (ascii4(bytes, 4) === 'ftyp') return 'image';

  const sample = bytes.subarray(0, SNIFF_SAMPLE);
  let controls = 0;
  for (const byte of sample) {
    // No encoding accepted here produces a NUL byte, so one is proof this is not text.
    if (byte === 0x00) return 'unknown';
    if (byte < 0x20 && !isTextControl(byte)) controls += 1;
  }
  return controls / sample.length > MAX_CONTROL_SHARE ? 'unknown' : null;
}

/**
 * Does the decoded text read as text? Counts what a plain-text export does not contain — control
 * characters beyond tab / newline / form feed, and the U+FFFD replacement character a lossy
 * decode leaves behind — over a leading sample.
 */
function looksLikeText(text: string): boolean {
  let total = 0;
  let bad = 0;
  for (const char of text.slice(0, SNIFF_SAMPLE)) {
    total += 1;
    const code = char.codePointAt(0) ?? 0;
    if (code === 0xfffd || (code < 0x20 && !isTextControl(code))) bad += 1;
  }
  return total === 0 || bad / total <= MAX_CONTROL_SHARE;
}

/** The encoding a byte-order mark declares, or `null` when there is none. */
function encodingFromBom(bytes: Uint8Array): ImportFileEncoding | null {
  if (startsWith(bytes, [0xef, 0xbb, 0xbf])) return 'utf-8';
  if (startsWith(bytes, [0xff, 0xfe])) return 'utf-16le';
  if (startsWith(bytes, [0xfe, 0xff])) return 'utf-16be';
  return null;
}

/**
 * Decode `bytes` as `encoding`, or `null` when they are not valid in it. `fatal` is what makes
 * this a *check* rather than a guess: an invalid UTF-8 sequence throws instead of quietly becoming
 * a replacement character. (A decoder the platform does not provide also lands here as `null`.)
 */
function decodeStrictly(bytes: Uint8Array, encoding: ImportFileEncoding): string | null {
  try {
    return new TextDecoder(encoding, { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

/**
 * The pure half of {@link readImportFile}: classify and decode already-loaded bytes.
 *
 * Encodings are tried in order of confidence — a byte-order mark is taken at its word, otherwise
 * UTF-8 first and Windows-1252 only once UTF-8 has been *proven* wrong. A successful read always
 * reports which encoding produced it, so the UI can flag the fallback.
 */
export function decodeImportFileBytes(
  bytes: Uint8Array,
  limitBytes: number = MAX_IMPORT_FILE_BYTES,
): ImportFileRead {
  if (bytes.length === 0) return { ok: false, rejection: { reason: 'empty' } };
  if (bytes.length > limitBytes) {
    return { ok: false, rejection: { reason: 'tooLarge', bytes: bytes.length, limitBytes } };
  }

  const bom = encodingFromBom(bytes);
  if (bom !== 'utf-16le' && bom !== 'utf-16be') {
    const kind = sniffBinaryKind(bytes);
    if (kind !== null) return { ok: false, rejection: { reason: 'binary', kind } };
  }

  // A UTF-8 BOM still goes through the UTF-8 → Windows-1252 ladder: the mark says what the
  // producer intended, and a mis-encoded body should fall back rather than fail outright.
  const attempts: readonly ImportFileEncoding[] =
    bom === 'utf-16le' || bom === 'utf-16be' ? [bom] : ['utf-8', 'windows-1252'];

  for (const encoding of attempts) {
    const text = decodeStrictly(bytes, encoding);
    if (text === null) continue;
    if (!looksLikeText(text)) return { ok: false, rejection: { reason: 'binary', kind: 'unknown' } };
    // Whitespace-only input parses to nothing at all; say so rather than opening a blank preview.
    if (text.trim().length === 0) return { ok: false, rejection: { reason: 'empty' } };
    return { ok: true, text, encoding };
  }
  return { ok: false, rejection: { reason: 'unreadable' } };
}

/**
 * Read a picked file into import text, or report why it cannot be one. Never throws — every
 * outcome, including a failed read, comes back as an {@link ImportFileRead} the UI can render.
 */
export async function readImportFile(
  file: File,
  limitBytes: number = MAX_IMPORT_FILE_BYTES,
): Promise<ImportFileRead> {
  // Checked before the read, not after: the point of the cap is that an oversized selection never
  // reaches memory in the first place.
  if (file.size === 0) return { ok: false, rejection: { reason: 'empty' } };
  if (file.size > limitBytes) {
    return { ok: false, rejection: { reason: 'tooLarge', bytes: file.size, limitBytes } };
  }
  try {
    return decodeImportFileBytes(new Uint8Array(await file.arrayBuffer()), limitBytes);
  } catch {
    // The file moved, its permission was revoked, or the disk read failed — the picker gives
    // nothing more to go on than "it did not read".
    return { ok: false, rejection: { reason: 'unreadable' } };
  }
}
