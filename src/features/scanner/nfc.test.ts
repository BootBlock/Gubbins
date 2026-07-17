import { describe, expect, it } from 'vitest';
import { firstScannableString, ndefMessageToScanStrings, type NdefRecord } from './nfc';

/** Encode a string as a UTF-8 `DataView`, as the Web NFC API exposes a record's payload. */
function bytes(text: string): DataView {
  const encoded = new TextEncoder().encode(text);
  return new DataView(encoded.buffer, encoded.byteOffset, encoded.byteLength);
}

const url = (value: string): NdefRecord => ({ recordType: 'url', data: bytes(value) });
const text = (value: string, encoding?: string): NdefRecord => ({
  recordType: 'text',
  data: bytes(value),
  encoding,
});

describe('ndefMessageToScanStrings', () => {
  it('decodes a URL record — the shape Gubbins writes to a tag', () => {
    const message = { records: [url('https://example.test/Gubbins/#/inventory?item=abc')] };
    expect(ndefMessageToScanStrings(message)).toEqual(['https://example.test/Gubbins/#/inventory?item=abc']);
  });

  it('decodes an absolute-url record the same as a url record', () => {
    const message = {
      records: [{ recordType: 'absolute-url', data: bytes('gubbins:item:xyz') } as NdefRecord],
    };
    expect(ndefMessageToScanStrings(message)).toEqual(['gubbins:item:xyz']);
  });

  it('decodes a plain text record', () => {
    expect(ndefMessageToScanStrings({ records: [text('hello tag')] })).toEqual(['hello tag']);
  });

  it('honours a text record’s declared encoding', () => {
    const encoded = new TextEncoder().encode('utf16-ish');
    const record: NdefRecord = {
      recordType: 'text',
      // A bogus encoding falls back to a dropped record rather than throwing.
      encoding: 'utf-8',
      data: new DataView(encoded.buffer),
    };
    expect(ndefMessageToScanStrings({ records: [record] })).toEqual(['utf16-ish']);
  });

  it('prioritises a URL record ahead of a text record regardless of on-tag order', () => {
    const message = { records: [text('some label'), url('https://example.test/x')] };
    expect(ndefMessageToScanStrings(message)).toEqual(['https://example.test/x', 'some label']);
  });

  it('keeps on-tag order for records of equal priority (stable sort)', () => {
    const message = { records: [text('first'), text('second')] };
    expect(ndefMessageToScanStrings(message)).toEqual(['first', 'second']);
  });

  it('decodes a text-ish MIME record but not a binary one', () => {
    const textMime: NdefRecord = { recordType: 'mime', mediaType: 'text/plain', data: bytes('note') };
    const binaryMime: NdefRecord = { recordType: 'mime', mediaType: 'image/png', data: bytes('PNG') };
    expect(ndefMessageToScanStrings({ records: [binaryMime, textMime] })).toEqual(['note']);
  });

  it('extracts the URL from a smart-poster’s nested records', () => {
    const poster: NdefRecord = {
      recordType: 'smart-poster',
      toRecords: () => [text('Item label'), url('https://example.test/poster')],
    };
    expect(ndefMessageToScanStrings({ records: [poster] })).toEqual([
      'https://example.test/poster',
      'Item label',
    ]);
  });

  it('drops empty, unknown and payload-less records', () => {
    const message = {
      records: [
        { recordType: 'empty' } as NdefRecord,
        { recordType: 'unknown', data: bytes('?') } as NdefRecord,
        { recordType: 'url' } as NdefRecord, // no data
        url('https://example.test/kept'),
      ],
    };
    expect(ndefMessageToScanStrings(message)).toEqual(['https://example.test/kept']);
  });

  it('returns an empty array for a message with no decodable records', () => {
    expect(ndefMessageToScanStrings({ records: [{ recordType: 'empty' } as NdefRecord] })).toEqual([]);
  });
});

describe('firstScannableString', () => {
  it('returns the highest-priority candidate', () => {
    const message = { records: [text('label'), url('https://example.test/first')] };
    expect(firstScannableString(message)).toBe('https://example.test/first');
  });

  it('returns null when nothing is decodable', () => {
    expect(firstScannableString({ records: [] })).toBeNull();
  });
});
