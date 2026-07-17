/**
 * Tap-to-scan reading of NFC tags, alongside the camera scanner (issue #71, acceptance
 * criteria 1–3).
 *
 * When `active`, this arms `NDEFReader.scan()` and, for each tapped tag, decodes the NDEF
 * message to its best candidate string ({@link firstScannableString}) and hands it to `onRead`
 * — the very same raw-string entry point the camera decode uses, so a tag carrying an item
 * deep-link resolves through {@link parseScannedCode} with no NFC-specific parsing. The watch
 * stops (via an {@link AbortController}) whenever `active` goes false or the component unmounts.
 *
 * The scan itself needs a user gesture on first use (it triggers the one-time NFC permission
 * prompt); mounting the scanner overlay from the "Scan" tap satisfies that. Guarded behind
 * {@link getNdefReaderCtor}, so it is inert (`supported: false`, status `idle`) off Android
 * Chromium. The `onRead`/`onError` callbacks are read through refs so a new closure identity on
 * each render never restarts the watch.
 */
import { useEffect, useRef, useState } from 'react';
import { firstScannableString } from './nfc';
import { nfcErrorMessage } from './nfc-errors';
import { getNdefReaderCtor, type NdefReadingEvent } from './nfc-reader';

/** The read lifecycle: idle (inactive/unsupported) → starting → ready, or error. */
export type NfcScanStatus = 'idle' | 'starting' | 'ready' | 'error';

export interface NfcScanState {
  /** True where the Web NFC API exists — gate the "Ready to tap" indicator on this. */
  readonly supported: boolean;
  readonly status: NfcScanStatus;
  /** A user-facing error sentence when the watch couldn't start, else `null`. */
  readonly error: string | null;
}

export function useNfcScan({
  active,
  onRead,
  onError,
}: {
  /** Whether the reader should be watching (e.g. the overlay is open and the feature is on). */
  active: boolean;
  /** Called with the best decoded string from each tapped tag. */
  onRead: (raw: string) => void;
  /** Called when a tag couldn't be read (a garbled/empty tap), with plain-language copy. */
  onError?: (message: string) => void;
}): NfcScanState {
  const [status, setStatus] = useState<NfcScanStatus>('idle');
  const [error, setError] = useState<string | null>(null);

  // Latest callbacks, read inside the (stable) effect so changing closure identity never
  // tears down and re-arms the underlying NFC watch.
  const onReadRef = useRef(onRead);
  const onErrorRef = useRef(onError);
  onReadRef.current = onRead;
  onErrorRef.current = onError;

  const supported = getNdefReaderCtor() !== null;

  useEffect(() => {
    const Ctor = getNdefReaderCtor();
    if (!active || !Ctor) {
      setStatus('idle');
      setError(null);
      return;
    }

    const controller = new AbortController();
    const reader = new Ctor();
    setError(null);
    setStatus('starting');

    const onReading = (event: NdefReadingEvent) => {
      const raw = firstScannableString(event.message);
      if (raw !== null) onReadRef.current(raw);
      else onErrorRef.current?.('That tag doesn’t carry a code Gubbins can read.');
    };
    const onReadingError = () => onErrorRef.current?.('Couldn’t read that tag. Try tapping it again.');

    reader.addEventListener('reading', onReading);
    reader.addEventListener('readingerror', onReadingError);

    reader.scan({ signal: controller.signal }).then(
      () => {
        if (!controller.signal.aborted) setStatus('ready');
      },
      (err: unknown) => {
        if (controller.signal.aborted) return;
        setStatus('error');
        setError(nfcErrorMessage(err));
      },
    );

    return () => {
      controller.abort();
      reader.removeEventListener('reading', onReading);
      reader.removeEventListener('readingerror', onReadingError);
    };
  }, [active]);

  return { supported, status, error };
}
