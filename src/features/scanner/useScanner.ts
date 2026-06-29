/**
 * The camera engine that drives the scanner state machine (spec §6.1, §6.6).
 *
 * Wires the real browser device APIs to the pure {@link scannerReducer}:
 *  - `getUserMedia({ facingMode: 'environment' })` for the rear camera, dispatching
 *    PERMISSION_GRANTED / PERMISSION_DENIED.
 *  - a tiered {@link FrameDecoder} ({@link createDecoder}, §6.6): the native **Barcode
 *    Detection API** first, else an **off-thread WASM fallback** — a Web Worker running
 *    zxing core, fed either a transferred `OffscreenCanvas` bitmap (`'wasm'`, Phase 31) or
 *    main-thread-captured RGBA pixels for no-`OffscreenCanvas` browsers (`'wasm-canvas'`,
 *    Safari < 16.4, Phase 33) — else manual entry.
 *    Polled per animation frame while STREAM_ACTIVE; the slower WASM paths run on an **adaptive
 *    frame-skip cadence** ({@link decode-cadence}) that backs off as the camera stays idle and
 *    snaps back the instant a code is decoded — saving battery on low-end devices without
 *    sacrificing acquisition latency. The resolved engine is reported back via `onEngine` so the
 *    overlay can tailor its messaging.
 *  - the **Visibility API** (§6.1): backgrounding stops the track (SUSPEND) to save
 *    battery; returning re-opens. Unmount definitively tears down stream + RAF + decoder.
 *
 * All device access is feature-detected and guarded so unsupported environments
 * degrade gracefully rather than throwing.
 */
import { useCallback, useEffect, useRef, type Dispatch, type RefObject } from 'react';
import type { ScannerAction, ScannerStatus } from './scanner-machine';
import { createDecoder, type FrameDecoder, type ScannerEngine } from './barcode-decoder';
import { DEFAULT_SCANNER_SYMBOLOGY, type ScannerSymbology } from './scanner-formats';
import { initialCadence, nextCadence, DEFAULT_WASM_CADENCE } from './decode-cadence';

export function useScanner({
  videoRef,
  status,
  dispatch,
  onDecode,
  onEngine,
  symbology = DEFAULT_SCANNER_SYMBOLOGY,
}: {
  videoRef: RefObject<HTMLVideoElement | null>;
  status: ScannerStatus;
  dispatch: Dispatch<ScannerAction>;
  /** Called with each raw decoded string while the stream is active. */
  onDecode: (raw: string) => void;
  /** Called once the decoding engine is resolved (`native` | `wasm` | `wasm-canvas` | `none`). */
  onEngine?: (engine: ScannerEngine) => void;
  /**
   * Which symbology to scan (spec §6.6): all four by default, or a single format to cut
   * per-frame decode cost. Read once when the camera goes active (the decoder is resolved
   * and cached then); changing it takes effect next time the scanner is opened.
   */
  symbology?: ScannerSymbology;
}) {
  const streamRef = useRef<MediaStream | null>(null);
  const rafRef = useRef<number | null>(null);
  const decoderRef = useRef<FrameDecoder | null>(null);
  const onDecodeRef = useRef(onDecode);
  onDecodeRef.current = onDecode;
  const onEngineRef = useRef(onEngine);
  onEngineRef.current = onEngine;
  const symbologyRef = useRef(symbology);
  symbologyRef.current = symbology;

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

  // Run the barcode-decode polling loop while the stream is active. The decoder is
  // resolved once (native → lazy WASM → none) and cached; the WASM path runs on an
  // adaptive frame-skip cadence (fast when scanning, easing off when idle).
  useEffect(() => {
    if (status !== 'STREAM_ACTIVE') return;
    let active = true;
    let lastDecodeAt = 0;

    const runLoop = (decoder: FrameDecoder) => {
      // Native is hardware-cheap and decodes every frame; both worker-backed WASM fallbacks
      // ('wasm' OffscreenCanvas + 'wasm-canvas' main-thread capture) still cost per frame, so
      // their cadence adapts — fast while a code is near, easing off as the camera stays idle
      // (spec §6.6 / §6.1 battery). See {@link decode-cadence}.
      const adaptive = decoder.engine === 'wasm' || decoder.engine === 'wasm-canvas';
      let cadence = initialCadence(DEFAULT_WASM_CADENCE);
      const tick = async (now: number) => {
        if (!active) return;
        const video = videoRef.current;
        const minInterval = adaptive ? cadence.intervalMs : 0;
        if (video && video.readyState >= 2 && video.videoWidth > 0 && now - lastDecodeAt >= minInterval) {
          lastDecodeAt = now;
          const codes = await decoder.detect(video);
          if (!active) return;
          if (adaptive) cadence = nextCadence(cadence, codes.length > 0, DEFAULT_WASM_CADENCE);
          for (const raw of codes) onDecodeRef.current(raw);
        }
        if (active) rafRef.current = requestAnimationFrame((t) => void tick(t));
      };
      rafRef.current = requestAnimationFrame((t) => void tick(t));
    };

    const begin = async () => {
      let decoder = decoderRef.current;
      if (!decoder) {
        decoder = await createDecoder(symbologyRef.current);
        if (!active) {
          decoder.dispose();
          return;
        }
        decoderRef.current = decoder;
        onEngineRef.current?.(decoder.engine);
      }
      if (decoder.engine === 'none') return; // no engine → manual entry only
      runLoop(decoder);
    };
    void begin();

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

  // Definitive teardown on unmount: stop the stream and release the decoder.
  useEffect(
    () => () => {
      stopStream();
      decoderRef.current?.dispose();
      decoderRef.current = null;
    },
    [stopStream],
  );
}
