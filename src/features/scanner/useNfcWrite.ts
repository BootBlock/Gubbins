/**
 * Writing an item's deep-link URL to a blank NFC tag (issue #71, acceptance criterion 4).
 *
 * The Web NFC write is inherently gesture-driven: the user taps **Write to tag**, this arms
 * `NDEFReader.write()`, and a prompt asks them to hold a tag against the phone until the write
 * resolves. We write a single `url` record — the same deep-link the printed QR encodes — so a
 * later tap resolves through the scanner's existing {@link parseScannedCode} contract. The whole
 * lifecycle is surfaced as a small state machine the dialog renders; an {@link AbortController}
 * both powers the "Cancel" button and a safety timeout so an armed write never hangs forever.
 *
 * The reader/writer surface is guarded behind {@link getNdefReaderCtor}, so this hook is inert
 * (and `supported: false`) everywhere the API is absent. The pure error mapping is in
 * {@link ./nfc-errors}.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { nfcErrorMessage } from './nfc-errors';
import { getNdefReaderCtor } from './nfc-reader';

/** The write lifecycle: idle → writing → success | error (cancel returns to idle). */
export type NfcWriteStatus = 'idle' | 'writing' | 'success' | 'error';

export interface NfcWriteController {
  /** True where the Web NFC API exists — gate the UI on this (with the `nfc` feature). */
  readonly supported: boolean;
  readonly status: NfcWriteStatus;
  /** A user-facing error sentence when `status === 'error'`, else `null`. */
  readonly error: string | null;
  /** Arm a write of `url` to the next tapped tag. No-op if unsupported or already writing. */
  write(url: string): void;
  /** Abort an in-flight write (returns to idle) — the "Cancel" affordance. */
  cancel(): void;
  /** Clear a terminal (`success`/`error`) state back to idle. */
  reset(): void;
}

/** How long an armed write waits for a tap before giving up, so the UI never hangs. */
const WRITE_TIMEOUT_MS = 30_000;

export function useNfcWrite(): NfcWriteController {
  const [status, setStatus] = useState<NfcWriteStatus>('idle');
  const [error, setError] = useState<string | null>(null);
  // The in-flight write's controller, so cancel()/unmount can abort it. A ref (not state) so
  // aborting never itself triggers a render.
  const controllerRef = useRef<AbortController | null>(null);
  // Whether the hook is still mounted, so the fire-and-forget write chain never resolves a
  // status onto an unmounted component (the promise can settle after the dialog is gone).
  const mountedRef = useRef(true);

  const supported = getNdefReaderCtor() !== null;

  const abort = useCallback(() => {
    controllerRef.current?.abort();
    controllerRef.current = null;
  }, []);

  // Abort any armed write if the dialog unmounts mid-tap, and stop honouring late settlements.
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      abort();
    };
  }, [abort]);

  const write = useCallback((url: string) => {
    const Ctor = getNdefReaderCtor();
    if (!Ctor || controllerRef.current) return;

    const controller = new AbortController();
    controllerRef.current = controller;
    const timeout = setTimeout(() => controller.abort(), WRITE_TIMEOUT_MS);
    setError(null);
    setStatus('writing');

    void new Ctor()
      .write({ records: [{ recordType: 'url', data: url }] }, { overwrite: true, signal: controller.signal })
      .then(() => {
        if (controller.signal.aborted || !mountedRef.current) return;
        setStatus('success');
      })
      .catch((err: unknown) => {
        if (!mountedRef.current) return;
        // A cancel()/timeout abort is not a failure — fall back to idle quietly.
        if (controller.signal.aborted) {
          setStatus('idle');
          return;
        }
        setError(nfcErrorMessage(err));
        setStatus('error');
      })
      .finally(() => {
        clearTimeout(timeout);
        if (controllerRef.current === controller) controllerRef.current = null;
      });
  }, []);

  const cancel = useCallback(() => {
    abort();
    setStatus('idle');
    setError(null);
  }, [abort]);

  const reset = useCallback(() => {
    setStatus('idle');
    setError(null);
  }, []);

  return { supported, status, error, write, cancel, reset };
}
