/**
 * Web NFC (tap-to-scan and tag-writing) — the pure NDEF-decoding step and the minimal
 * type shims the browser-only hooks build on (issue #71).
 *
 * The Web NFC API (`NDEFReader`) lets a supported device (Chromium on Android) read and
 * write **NDEF** messages by tapping a passive tag. Gubbins uses it as a second way to
 * scan — a tapped tag carrying an item deep-link resolves through the very same
 * {@link parseScannedCode} contract the camera feeds — and to *write* an item's deep-link
 * URL to a blank tag from the label dialog, mirroring the printed QR code.
 *
 * A read yields an {@link NdefMessage} of one or more {@link NdefRecord}s, each a typed blob
 * (`recordType` + a `DataView` of bytes). This module's job is the pure, unit-testable part:
 * turn a message into the candidate text strings a tag might carry, in the order most likely
 * to be a Gubbins code — URL records first (what we and a QR-equivalent tag write), then
 * plain text, then text-ish MIME. The browser side ({@link useNfcScan}) feeds the best
 * candidate into the scanner's existing decode path; nothing here touches the DOM or the API.
 *
 * The DOM lib does not model `NDEFReader`, so the shapes below are declared locally (the same
 * approach the Barcode Detection code takes) and kept to just the fields we read.
 */

/** A single NDEF record, narrowed to the fields we decode. Mirrors the Web NFC `NDEFRecord`. */
export interface NdefRecord {
  /** e.g. `'url'`, `'absolute-url'`, `'text'`, `'mime'`, `'smart-poster'`, `'empty'`. */
  readonly recordType: string;
  /** MIME type for `recordType: 'mime'` records. */
  readonly mediaType?: string;
  /** Text encoding for `recordType: 'text'` records (`'utf-8'` | `'utf-16'`). */
  readonly encoding?: string;
  /** The record payload bytes. Absent for `'empty'` records. */
  readonly data?: DataView;
  /** Nested records for a `'smart-poster'` (and other composite) record. */
  toRecords?(): NdefRecord[];
}

/** An NDEF message: an ordered list of records. Mirrors the Web NFC `NDEFMessage`. */
export interface NdefMessage {
  readonly records: readonly NdefRecord[];
}

/**
 * Priority buckets — a URL record is the likeliest Gubbins code, so it is tried first, then
 * plain text, then text-ish MIME. Lower sorts earlier. A plain const map (not a TS enum) to
 * match the scanner's union/const-object style.
 */
const PRIORITY = { url: 0, text: 1, mimeText: 2 } as const;
type Priority = (typeof PRIORITY)[keyof typeof PRIORITY];

/** Decode a record's `DataView` payload to a string with the given encoding; `null` on failure. */
function decodeBytes(data: DataView | undefined, encoding = 'utf-8'): string | null {
  if (!data) return null;
  try {
    return new TextDecoder(encoding).decode(data);
  } catch {
    return null;
  }
}

/** True for a MIME type whose payload is reasonably decoded as UTF-8 text. */
function isTextMime(mediaType: string | undefined): boolean {
  if (!mediaType) return false;
  const type = mediaType.toLowerCase();
  return type.startsWith('text/') || type === 'application/json';
}

/**
 * Collect `{ priority, value }` candidates from one record, recursing into a smart-poster's
 * nested records. `depth` guards against a malformed self-referential composite record.
 */
function collectFromRecord(
  record: NdefRecord,
  depth: number,
  out: { priority: Priority; value: string }[],
): void {
  switch (record.recordType) {
    case 'url':
    case 'absolute-url': {
      const value = decodeBytes(record.data);
      if (value) out.push({ priority: PRIORITY.url, value });
      return;
    }
    case 'text': {
      const value = decodeBytes(record.data, record.encoding ?? 'utf-8');
      if (value) out.push({ priority: PRIORITY.text, value });
      return;
    }
    case 'mime': {
      if (!isTextMime(record.mediaType)) return;
      const value = decodeBytes(record.data);
      if (value) out.push({ priority: PRIORITY.mimeText, value });
      return;
    }
    case 'smart-poster': {
      // A smart-poster wraps its own records (a URL plus title/action). Recurse to pull the URL
      // out, bounded so a pathological self-nesting record can never loop forever.
      if (depth <= 0 || typeof record.toRecords !== 'function') return;
      for (const nested of record.toRecords()) collectFromRecord(nested, depth - 1, out);
      return;
    }
    default:
      // 'empty', 'unknown', external types, etc. — nothing we can turn into a scan string.
      return;
  }
}

/**
 * Decode an NDEF message into the candidate scan strings it carries, most-likely-a-Gubbins-code
 * first: URL records (what Gubbins and a QR-equivalent tag write), then plain-text records, then
 * text-ish MIME records. Records that carry no decodable text (empty/binary/unknown) are dropped.
 * The sort is **stable**, so records of equal priority keep their on-tag order. Pure — the caller
 * decides what to do with the result.
 */
export function ndefMessageToScanStrings(message: NdefMessage): string[] {
  const candidates: { priority: Priority; value: string }[] = [];
  for (const record of message.records) collectFromRecord(record, 4, candidates);
  return candidates
    .map((c, index) => ({ ...c, index }))
    .sort((a, b) => a.priority - b.priority || a.index - b.index)
    .map((c) => c.value);
}

/**
 * The single best candidate string from a tapped NDEF message — the first URL record, else the
 * first text/MIME string — or `null` when the tag carries nothing decodable. This is what the
 * reader feeds into the scanner's decode path.
 */
export function firstScannableString(message: NdefMessage): string | null {
  return ndefMessageToScanStrings(message)[0] ?? null;
}
