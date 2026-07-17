/**
 * Minimal `NDEFReader` type shims + a guarded constructor accessor (issue #71).
 *
 * The DOM lib does not model the Web NFC API, so the reader/writer surface Gubbins uses is
 * declared here — kept to just the members the read ({@link useNfcScan}) and write
 * ({@link useNfcWrite}) hooks touch. Everything is behind {@link getNdefReaderCtor}, which
 * returns the constructor only where the API actually exists, so no call site ever references
 * a global that isn't there. The pure NDEF decoding lives in {@link ./nfc}.
 */
import type { NdefMessage } from './nfc';

/** A record to write. Gubbins only writes `url` records (an item's deep-link). */
export interface NdefWriteRecord {
  readonly recordType: 'url' | 'text';
  readonly data: string;
}

/** Options for a write, mirroring the Web NFC `NDEFWriteOptions`. */
export interface NdefWriteOptions {
  /** Overwrite an existing message rather than rejecting; Gubbins overwrites. */
  readonly overwrite?: boolean;
  readonly signal?: AbortSignal;
}

/** A `reading` event — a tapped tag's decoded message plus its serial. */
export interface NdefReadingEvent {
  readonly message: NdefMessage;
  readonly serialNumber: string;
}

/** The subset of `NDEFReader` the hooks use. */
export interface NdefReader {
  scan(options?: { signal?: AbortSignal }): Promise<void>;
  write(message: { records: readonly NdefWriteRecord[] } | string, options?: NdefWriteOptions): Promise<void>;
  addEventListener(type: 'reading', listener: (event: NdefReadingEvent) => void): void;
  addEventListener(type: 'readingerror', listener: (event: Event) => void): void;
  removeEventListener(type: 'reading', listener: (event: NdefReadingEvent) => void): void;
  removeEventListener(type: 'readingerror', listener: (event: Event) => void): void;
}

/** The `NDEFReader` constructor. */
export type NdefReaderCtor = new () => NdefReader;

/**
 * The `NDEFReader` constructor where the Web NFC API is present, else `null`. A single guarded
 * read of the global so no hook ever names `NDEFReader` directly (it is undefined off Android
 * Chromium). Pairs with `hasNfc()` from feature-detection, which callers use to gate the UI.
 */
export function getNdefReaderCtor(): NdefReaderCtor | null {
  const ctor = (globalThis as { NDEFReader?: NdefReaderCtor }).NDEFReader;
  return typeof ctor === 'function' ? ctor : null;
}
