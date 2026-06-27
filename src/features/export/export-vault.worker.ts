/**
 * Markdown-vault zip worker (spec §4.5, §2 mobile-fallback archiving).
 *
 * Archiving runs off the main thread in a Web Worker using **fflate** (the lean
 * archiver named in §4.5 / §2, preferred over JSZip per the §2.4.3 lean mandate),
 * so zipping a large vault never blocks the UI. It receives a `path → text` file
 * map, encodes each entry to bytes, and posts back the zipped `Uint8Array`.
 */
import { zipSync, strToU8 } from 'fflate';

export interface VaultZipRequest {
  readonly files: Record<string, string>;
}
export interface VaultZipResponse {
  readonly zip: Uint8Array;
}

self.onmessage = (event: MessageEvent<VaultZipRequest>) => {
  const { files } = event.data;
  const entries: Record<string, Uint8Array> = {};
  for (const [path, text] of Object.entries(files)) {
    entries[path] = strToU8(text);
  }
  const zip = zipSync(entries, { level: 6 });
  const response: VaultZipResponse = { zip };
  // Transfer the underlying buffer to avoid a copy.
  (self as unknown as Worker).postMessage(response, [zip.buffer]);
};
