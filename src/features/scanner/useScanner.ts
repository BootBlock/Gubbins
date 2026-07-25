/**
 * The camera engine that drives the scanner state machine (spec §6.1, §6.6).
 *
 * Wires the real browser device APIs to the pure {@link scannerReducer}:
 *  - `getUserMedia` for the rear camera — or the one the user picked (issue #135) — dispatching
 *    PERMISSION_GRANTED / PERMISSION_DENIED.
 *  - the **camera controls** the returned {@link ScannerCameraControls} exposes to the viewfinder:
 *    the camera's own **torch** for the badly-lit places inventory actually lives in, and the list
 *    of cameras to switch between (a phone's default rear lens is often the ultra-wide, which
 *    cannot focus at barcode-reading distance). Both are feature-detected per camera, so a device
 *    that offers neither shows neither control.
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
 *
 * **Lab flag** (`/lab`, hidden testing screen): `no-camera` makes the permission-request
 * effect skip `getUserMedia` entirely and dispatch the same `STREAM_ERROR` a genuinely
 * camera-less device would, so the fallback/manual-entry UI can be checked on a machine
 * that has a working camera.
 */
import { useCallback, useEffect, useRef, useState, type Dispatch, type RefObject } from 'react';
import type { ScannerAction, ScannerStatus } from './scanner-machine';
import { useLabFlag } from '@/state/stores/useLabStore';
import { useT } from '@/features/i18n';
import { createDecoder, type FrameDecoder, type ScannerEngine } from './barcode-decoder';
import { DEFAULT_SCANNER_SYMBOLOGY, type ScannerSymbology } from './scanner-formats';
import { initialCadence, nextCadence, DEFAULT_WASM_CADENCE } from './decode-cadence';
import { elementRoiOf } from './roi';
import { applyScannerTorch, applyScannerTrackConstraints, scannerTorchSupported } from './camera-constraints';
import { buildVideoConstraints, listCameras, type CameraOption } from './camera-devices';

/** The camera's own hardware controls, for the viewfinder to render (issue #135). */
export interface ScannerCameraControls {
  /** The camera torch. `supported: false` where this camera has none — offer no toggle then. */
  readonly torch: {
    readonly supported: boolean;
    readonly on: boolean;
    /** Flip the torch. A camera that refuses reports through `onCameraWarning` and stays put. */
    readonly toggle: () => void;
  };
  /**
   * The cameras this device offers, in the platform's own order. Empty until a stream has been
   * granted (browsers withhold device labels before that) and where enumeration is unsupported.
   */
  readonly cameras: readonly CameraOption[];
  /**
   * The camera actually streaming, as reported by the live track — **not** the requested
   * `cameraId`. The two differ when a remembered camera has gone away and the default was opened
   * instead, and the picker must show what is really on screen.
   */
  readonly activeCameraId: string | null;
}

export function useScanner({
  videoRef,
  roiRef,
  status,
  dispatch,
  onDecode,
  onEngine,
  onCameraWarning,
  symbology = DEFAULT_SCANNER_SYMBOLOGY,
  cameraId,
}: {
  videoRef: RefObject<HTMLVideoElement | null>;
  /**
   * The reticle box element the user aims into (issue #59): the decoder crops each frame to it, so
   * a framed barcode is large relative to the analysed pixels on any viewport shape. When absent
   * or unmeasurable the crop falls back to the cover-visible region, then the whole frame.
   */
  roiRef?: RefObject<HTMLElement | null>;
  status: ScannerStatus;
  dispatch: Dispatch<ScannerAction>;
  /** Called with each raw decoded string while the stream is active. */
  onDecode: (raw: string) => void;
  /** Called once the decoding engine is resolved (`native` | `wasm` | `wasm-canvas` | `none`). */
  onEngine?: (engine: ScannerEngine) => void;
  /**
   * A soft camera problem for the caller to show in its own notice region (issue #135) — a torch
   * the camera refused, or a remembered camera that has gone away and was swapped for the default.
   * Neither stops the scan, so neither is a `STREAM_ERROR`; the caller already owns the live region
   * that makes such a message reach a screen-reader user.
   */
  onCameraWarning?: (message: string) => void;
  /**
   * Which symbology to scan (spec §6.6): all four by default, or a single format to cut
   * per-frame decode cost. Read once when the camera goes active (the decoder is resolved
   * and cached then); changing it takes effect next time the scanner is opened.
   */
  symbology?: ScannerSymbology;
  /**
   * The camera to open, as a `deviceId` the user picked from the viewfinder's camera menu and the
   * caller remembered (issue #135). Empty/omitted asks for "a rear camera" and lets the browser
   * choose — the first-run default. Changing it re-opens the stream on the new camera in place.
   */
  cameraId?: string;
}): ScannerCameraControls {
  const streamRef = useRef<MediaStream | null>(null);
  const rafRef = useRef<number | null>(null);
  const decoderRef = useRef<FrameDecoder | null>(null);
  const onDecodeRef = useRef(onDecode);
  onDecodeRef.current = onDecode;
  const onEngineRef = useRef(onEngine);
  onEngineRef.current = onEngine;
  const onCameraWarningRef = useRef(onCameraWarning);
  onCameraWarningRef.current = onCameraWarning;
  const symbologyRef = useRef(symbology);
  symbologyRef.current = symbology;
  // The camera the caller wants, normalised so "no choice" is one value throughout.
  const wantedCameraId = cameraId ?? '';
  const wantedCameraIdRef = useRef(wantedCameraId);
  wantedCameraIdRef.current = wantedCameraId;
  // Which *requested* camera the live stream was opened for — compared against `wantedCameraId` to
  // spot a switch. Deliberately the request, not what the browser actually gave us: when a
  // remembered camera has gone away we fall back to the default, and recording the fallback's real
  // id here would read as a fresh switch on every render and re-acquire for ever.
  const openedCameraRef = useRef<string | null>(null);
  const roiRefRef = useRef(roiRef);
  roiRefRef.current = roiRef;
  // The ROI provider the decoder analyses each frame: the live reticle box when present, else the
  // cover-visible region. Stable identity (reads the refs live), so the once-resolved decoder that
  // captures it always sees the current reticle geometry.
  const computeRoi = useRef((source: HTMLVideoElement) =>
    elementRoiOf(source, roiRefRef.current?.current ?? null),
  ).current;
  const noCamera = useLabFlag('no-camera');
  const t = useT();
  const tRef = useRef(t);
  tRef.current = t;

  // The camera's hardware controls (issue #135). Torch support/state and the streaming camera all
  // belong to the *live track*, so they are re-probed on every acquisition and cleared the moment
  // the stream stops — a stale "torch on" over a dead camera would be a lie the user can't act on.
  const [torchSupported, setTorchSupported] = useState(false);
  const [torchOn, setTorchOn] = useState(false);
  const torchOnRef = useRef(torchOn);
  torchOnRef.current = torchOn;
  // The device's camera list is a property of the *device*, not the track, so it deliberately
  // survives a stop: it stays correct across a camera swap, and the picker comes back populated
  // rather than empty for as long as enumeration takes.
  const [cameras, setCameras] = useState<readonly CameraOption[]>([]);
  const [activeCameraId, setActiveCameraId] = useState<string | null>(null);

  const stopStream = useCallback(() => {
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    openedCameraRef.current = null;
    setTorchSupported(false);
    setTorchOn(false);
    setActiveCameraId(null);
    if (videoRef.current) videoRef.current.srcObject = null;
  }, [videoRef]);

  // Acquire the camera when entering REQUESTING_PERMISSIONS.
  useEffect(() => {
    if (status !== 'REQUESTING_PERMISSIONS') return;
    let cancelled = false;
    // Pretend the device has no usable camera (lab flag) — take the same path a genuinely
    // camera-less browser would, without ever calling getUserMedia.
    if (noCamera) {
      dispatch({ type: 'STREAM_ERROR', message: 'This device has no camera support.' });
      return;
    }
    const media = navigator.mediaDevices?.getUserMedia;
    if (!media) {
      dispatch({ type: 'STREAM_ERROR', message: 'This device has no camera support.' });
      return;
    }
    // The camera to open, read live so a switch that arrived while we were mounting is honoured.
    const requested = wantedCameraIdRef.current;
    // Open the requested camera, falling back to the browser's own rear-camera pick when a
    // remembered one can no longer be opened (issue #135) — a camera detached, or an id the
    // browser rotated when permission was cleared. Dead-ending on a choice made once and no longer
    // visible would leave "Try the camera again" retrying the same impossible request for ever.
    const openCamera = async (): Promise<MediaStream> => {
      // Ask for a higher-resolution frame than the browser's low default (often 480p): more
      // pixels per bar gives a far better read on a poor camera and lets a barcode be held
      // closer without going soft (issue #58). `ideal` is best-effort — it never rejects when
      // the camera can't meet it, so this only ever helps.
      try {
        return await navigator.mediaDevices.getUserMedia({
          video: buildVideoConstraints(requested),
          audio: false,
        });
      } catch (err) {
        if (requested === '') throw err;
        const stream = await navigator.mediaDevices.getUserMedia({
          video: buildVideoConstraints(null),
          audio: false,
        });
        if (!cancelled) onCameraWarningRef.current?.(tRef.current('scanner.camera.unavailable'));
        return stream;
      }
    };
    openCamera()
      .then((stream) => {
        if (cancelled) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        streamRef.current = stream;
        openedCameraRef.current = requested;
        // Re-probe the camera's own controls for *this* track: whether it has a torch (off on a
        // fresh track), which camera actually opened, and what else this device offers to switch
        // to. Enumeration only carries usable labels once a stream has been granted, which is why
        // it happens here rather than on mount.
        setTorchSupported(scannerTorchSupported(stream));
        setTorchOn(false);
        setActiveCameraId(stream.getVideoTracks()[0]?.getSettings?.().deviceId ?? null);
        // Guarded on the stream still being the live one, deliberately *not* on `cancelled`: the
        // grant below moves the machine to STREAM_ACTIVE, which re-runs this very effect and so
        // cancels it a beat later — every time. A `cancelled` check here would race that and
        // usually lose, leaving the picker permanently empty.
        void listCameras().then((found) => {
          if (streamRef.current === stream) setCameras(found);
        });
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          // A granted stream still has to *play*: iOS Safari's autoplay policy can refuse, and a
          // detached element aborts. Surfacing it beats leaving the overlay in its normal
          // "scanning" state over a black frame the user waves a barcode at (issue #317). Guarded
          // on the stream still being the live one, so the AbortError that teardown itself
          // provokes (srcObject cleared) never masquerades as a failure.
          void videoRef.current.play().catch(() => {
            if (streamRef.current !== stream) return;
            dispatch({
              type: 'STREAM_ERROR',
              message: 'The camera preview could not be started. You can still enter codes manually.',
            });
          });
        }
        // Best-effort: ask the camera for continuous autofocus so a barcode held at reading
        // distance stays sharp — a blurry frame is a common reason a clear code "won't scan"
        // (issue #59). Fire-and-forget and fully guarded: cameras that can't focus on demand
        // simply ignore it, so this only ever helps and never blocks the grant.
        void applyScannerTrackConstraints(stream);
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
  }, [status, dispatch, videoRef, noCamera]);

  // The user picked a different camera (issue #135): drop the current track — many devices refuse
  // to open a second camera while the first is live — and go back through REQUESTING_PERMISSIONS so
  // the one acquisition effect above opens the new one. Guarded on there being a live stream, so a
  // remembered choice restored before the first open is simply used by that open.
  useEffect(() => {
    if (status !== 'STREAM_ACTIVE') return;
    if (!streamRef.current || openedCameraRef.current === wantedCameraId) return;
    stopStream();
    dispatch({ type: 'REOPEN' });
  }, [status, wantedCameraId, stopStream, dispatch]);

  // Flip the camera torch. The state only follows a change the camera actually accepted, so the
  // toggle can never show a lit torch over a dark frame; a refusal is reported to the caller's
  // notice region instead (it is the channel a screen-reader user hears).
  const toggleTorch = useCallback(() => {
    const stream = streamRef.current;
    if (!stream) return;
    const next = !torchOnRef.current;
    void applyScannerTorch(stream, next).then((accepted) => {
      if (streamRef.current !== stream) return; // the stream was swapped out mid-apply
      if (accepted) {
        setTorchOn(next);
        return;
      }
      const failed = next ? 'scanner.torch.failedOn' : 'scanner.torch.failedOff';
      onCameraWarningRef.current?.(tRef.current(failed));
    });
  }, []);

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
        decoder = await createDecoder(symbologyRef.current, computeRoi);
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
  }, [status, videoRef, computeRoi]);

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

  return { torch: { supported: torchSupported, on: torchOn, toggle: toggleTorch }, cameras, activeCameraId };
}
