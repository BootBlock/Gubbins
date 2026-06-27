/**
 * The camera engine that drives the scanner state machine (spec §6.1, §6.6).
 *
 * Wires the real browser device APIs to the pure {@link scannerReducer}:
 *  - `getUserMedia({ facingMode: 'environment' })` for the rear camera, dispatching
 *    PERMISSION_GRANTED / PERMISSION_DENIED.
 *  - the native **Barcode Detection API** (§6.6 primary engine) polled per animation
 *    frame while STREAM_ACTIVE; absent it, decoding falls back to manual entry in the
 *    overlay (the §6.6 WASM fallback is deferred — see PHASE_HANDOVER §7).
 *  - the **Visibility API** (§6.1): backgrounding stops the track (SUSPEND) to save
 *    battery; returning re-opens. Unmount definitively tears down stream + RAF.
 *
 * All device access is feature-detected and guarded so unsupported environments
 * degrade gracefully rather than throwing.
 */
import { useCallback, useEffect, useRef, type Dispatch, type RefObject } from 'react';
import type { ScannerAction, ScannerStatus } from './scanner-machine';
import { hasBarcodeDetector } from './feedback';

// Minimal typing for the experimental Barcode Detection API (not in lib.dom yet).
interface DetectedBarcode {
  readonly rawValue: string;
}
interface BarcodeDetectorLike {
  detect(source: CanvasImageSource): Promise<DetectedBarcode[]>;
}
interface BarcodeDetectorCtor {
  new (options?: { formats?: string[] }): BarcodeDetectorLike;
  getSupportedFormats?(): Promise<string[]>;
}

function makeDetector(): BarcodeDetectorLike | null {
  if (!hasBarcodeDetector()) return null;
  try {
    const Ctor = (window as unknown as { BarcodeDetector: BarcodeDetectorCtor }).BarcodeDetector;
    return new Ctor({ formats: ['qr_code', 'code_128', 'ean_13', 'code_39'] });
  } catch {
    return null;
  }
}

export function useScanner({
  videoRef,
  status,
  dispatch,
  onDecode,
}: {
  videoRef: RefObject<HTMLVideoElement | null>;
  status: ScannerStatus;
  dispatch: Dispatch<ScannerAction>;
  /** Called with each raw decoded string while the stream is active. */
  onDecode: (raw: string) => void;
}) {
  const streamRef = useRef<MediaStream | null>(null);
  const rafRef = useRef<number | null>(null);
  const detectorRef = useRef<BarcodeDetectorLike | null>(null);
  const onDecodeRef = useRef(onDecode);
  onDecodeRef.current = onDecode;

  const stopStream = useCallback(() => {
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    if (videoRef.current) videoRef.current.srcObject = null;
  }, [videoRef]);

  // Acquire the camera when entering REQUESTING_PERMISSIONS.
  useEffect(() => {
    if (status !== 'REQUESTING_PERMISSIONS') return;
    let cancelled = false;
    const media = navigator.mediaDevices?.getUserMedia;
    if (!media) {
      dispatch({ type: 'STREAM_ERROR', message: 'This device has no camera support.' });
      return;
    }
    navigator.mediaDevices
      .getUserMedia({ video: { facingMode: 'environment' }, audio: false })
      .then((stream) => {
        if (cancelled) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        streamRef.current = stream;
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          void videoRef.current.play().catch(() => {});
        }
        dispatch({ type: 'PERMISSION_GRANTED' });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        const name = err instanceof DOMException ? err.name : '';
        dispatch({
          type: 'PERMISSION_DENIED',
          message:
            name === 'NotAllowedError'
              ? 'Camera access was denied. Allow it in your browser, or enter codes manually.'
              : 'The camera could not be started. You can still enter codes manually.',
        });
      });
    return () => {
      cancelled = true;
    };
  }, [status, dispatch, videoRef]);

  // Run the Barcode-Detection polling loop while the stream is active.
  useEffect(() => {
    if (status !== 'STREAM_ACTIVE') return;
    detectorRef.current ??= makeDetector();
    const detector = detectorRef.current;
    if (!detector) return; // no native detector → manual entry only

    let active = true;
    const tick = async () => {
      if (!active) return;
      const video = videoRef.current;
      if (video && video.readyState >= 2 && video.videoWidth > 0) {
        try {
          const codes = await detector.detect(video);
          for (const code of codes) if (code.rawValue) onDecodeRef.current(code.rawValue);
        } catch {
          // transient detect errors are ignored; the loop continues
        }
      }
      if (active) rafRef.current = requestAnimationFrame(() => void tick());
    };
    rafRef.current = requestAnimationFrame(() => void tick());
    return () => {
      active = false;
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
    };
  }, [status, videoRef]);

  // Stop the camera whenever we are not actively streaming.
  useEffect(() => {
    if (status === 'IDLE' || status === 'ERROR_STATE') stopStream();
  }, [status, stopStream]);

  // Visibility API: drop the stream when backgrounded to save battery (§6.1).
  useEffect(() => {
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') dispatch({ type: 'SUSPEND' });
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  }, [dispatch]);

  // Definitive teardown on unmount.
  useEffect(() => stopStream, [stopStream]);
}
