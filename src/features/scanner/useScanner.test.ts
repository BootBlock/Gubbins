/**
 * Behaviour tests for the {@link useScanner} camera-acquisition effect — specifically the
 * `no-camera` lab flag (`/lab`, hidden testing screen). The decode-loop / visibility / teardown
 * effects need a real video element and decoder plumbing that isn't exercised here; those are
 * covered indirectly by the component tests that neuter this hook entirely
 * (`vi.mock('../useScanner', () => ({ useScanner: () => {} }))`). This file pins the one thing
 * only `useScanner` itself can prove: what happens when the permission-request effect runs.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { renderHook, cleanup, waitFor } from '@testing-library/react';
import { useEffect, useReducer, useRef } from 'react';
import { useScanner } from './useScanner';
import {
  initialScannerState,
  scannerReducer,
  type ScannerAction,
  type ScannerStatus,
} from './scanner-machine';
import { useLabStore } from '@/state/stores/useLabStore';

const CLEAN_LAB = { flags: {} } as const;

afterEach(() => {
  cleanup();
  useLabStore.setState(CLEAN_LAB);
  vi.restoreAllMocks();
});

function renderScanner(
  status: ScannerStatus,
  dispatch: (action: ScannerAction) => void,
  video: HTMLVideoElement | null = null,
  extra: { cameraId?: string; onCameraWarning?: (message: string) => void } = {},
) {
  const videoRef = { current: video };
  return renderHook(
    (props: { status: ScannerStatus; cameraId?: string }) =>
      useScanner({ videoRef, dispatch, onDecode: vi.fn(), ...extra, ...props }),
    { initialProps: { status, cameraId: extra.cameraId } },
  );
}

/** A video element stand-in whose `play()` resolves or rejects on command. */
function fakeVideo(play: () => Promise<void>) {
  return { srcObject: null, play } as unknown as HTMLVideoElement;
}

/** A stream stand-in: no tracks by default, so nothing probes as torch-capable. */
function fakeStream(tracks: unknown[] = []) {
  return { getTracks: () => tracks, getVideoTracks: () => tracks };
}

function mockCamera(stream: unknown = fakeStream(), devices?: unknown[]) {
  const getUserMedia = vi.fn().mockResolvedValue(stream);
  const enumerateDevices = vi.fn().mockResolvedValue(devices ?? []);
  Object.defineProperty(navigator, 'mediaDevices', {
    configurable: true,
    value: { getUserMedia, enumerateDevices },
  });
  return getUserMedia;
}

/**
 * The hook wired to the real state machine, exactly as both camera surfaces wire it. Worth the few
 * extra lines over driving `status` by hand: the machine's own REQUESTING_PERMISSIONS →
 * STREAM_ACTIVE transition re-runs the acquisition effect the instant permission is granted, and
 * anything the grant kicks off asynchronously has to survive that.
 */
function renderWiredToMachine(
  extra: { cameraId?: string; onCameraWarning?: (message: string) => void } = {},
) {
  return renderHook(() => {
    // A *stable* ref, as both real surfaces pass: it is in the acquisition effect's dependency
    // list, so a fresh object each render would re-run the whole camera lifecycle every render.
    const videoRef = useRef<HTMLVideoElement | null>(null);
    const [state, dispatch] = useReducer(scannerReducer, undefined, () => initialScannerState('DISCRETE'));
    useEffect(() => dispatch({ type: 'OPEN' }), []);
    const camera = useScanner({ videoRef, status: state.status, dispatch, onDecode: vi.fn(), ...extra });
    return { status: state.status, camera };
  });
}

describe('useScanner — camera acquisition (no-camera lab flag)', () => {
  it('pretends there is no camera support when the flag is on, without calling getUserMedia', async () => {
    useLabStore.setState({ flags: { 'no-camera': true } });
    const getUserMedia = vi.fn();
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: { getUserMedia },
    });
    const dispatch = vi.fn();

    renderScanner('REQUESTING_PERMISSIONS', dispatch);

    await waitFor(() => {
      expect(dispatch).toHaveBeenCalledWith({
        type: 'STREAM_ERROR',
        message: 'This device has no camera support.',
      });
    });
    expect(getUserMedia).not.toHaveBeenCalled();
  });

  it('requests the real camera as usual when the flag is off', async () => {
    const getUserMedia = mockCamera();
    const dispatch = vi.fn();

    renderScanner('REQUESTING_PERMISSIONS', dispatch);

    await waitFor(() => expect(getUserMedia).toHaveBeenCalled());
    await waitFor(() => expect(dispatch).toHaveBeenCalledWith({ type: 'PERMISSION_GRANTED' }));
  });

  it('surfaces a stream error when the granted stream refuses to play (issue #317)', async () => {
    mockCamera();
    const dispatch = vi.fn();
    const video = fakeVideo(() => Promise.reject(new DOMException('blocked', 'NotAllowedError')));

    renderScanner('REQUESTING_PERMISSIONS', dispatch, video);

    await waitFor(() => {
      expect(dispatch).toHaveBeenCalledWith({
        type: 'STREAM_ERROR',
        message: 'The camera preview could not be started. You can still enter codes manually.',
      });
    });
  });

  it('stays silent when playback aborts because the stream was already torn down', async () => {
    mockCamera();
    const dispatch = vi.fn();
    let rejectPlay!: (reason: unknown) => void;
    const video = fakeVideo(() => new Promise<void>((_, reject) => (rejectPlay = reject)));

    const { unmount } = renderScanner('REQUESTING_PERMISSIONS', dispatch, video);

    await waitFor(() => expect(dispatch).toHaveBeenCalledWith({ type: 'PERMISSION_GRANTED' }));
    unmount();
    rejectPlay(new DOMException('interrupted', 'AbortError'));
    await Promise.resolve();

    expect(dispatch).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'STREAM_ERROR' }));
  });

  it('reports no camera support when off and the browser genuinely has none (byte-identical baseline)', async () => {
    Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: undefined });
    const dispatch = vi.fn();

    renderScanner('REQUESTING_PERMISSIONS', dispatch);

    await waitFor(() => {
      expect(dispatch).toHaveBeenCalledWith({
        type: 'STREAM_ERROR',
        message: 'This device has no camera support.',
      });
    });
  });
});

/**
 * Choosing the camera (issue #135). On a phone with several rear lenses the browser's own pick is
 * frequently the ultra-wide, which cannot focus at barcode-reading distance — so a remembered
 * choice has to be *requested*, and has to survive the camera behind it going away.
 */
describe('useScanner — which camera opens', () => {
  it('asks for a rear camera when nothing is remembered', async () => {
    const getUserMedia = mockCamera();

    renderScanner('REQUESTING_PERMISSIONS', vi.fn());

    await waitFor(() => expect(getUserMedia).toHaveBeenCalled());
    expect(getUserMedia.mock.calls[0]?.[0].video).toMatchObject({ facingMode: 'environment' });
  });

  it('requests the remembered camera by id', async () => {
    const getUserMedia = mockCamera();

    renderScanner('REQUESTING_PERMISSIONS', vi.fn(), null, { cameraId: 'cam-tele' });

    await waitFor(() => expect(getUserMedia).toHaveBeenCalled());
    expect(getUserMedia.mock.calls[0]?.[0].video).toMatchObject({ deviceId: { exact: 'cam-tele' } });
  });

  it('falls back to the default camera — and says so — when a remembered one has gone away', async () => {
    // Otherwise a choice made once and no longer visible dead-ends the scanner: "Try the camera
    // again" would retry the same impossible request for ever.
    const getUserMedia = vi
      .fn()
      .mockRejectedValueOnce(new DOMException('gone', 'OverconstrainedError'))
      .mockResolvedValue(fakeStream());
    Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia } });
    const dispatch = vi.fn();
    const onCameraWarning = vi.fn();

    renderScanner('REQUESTING_PERMISSIONS', dispatch, null, { cameraId: 'cam-gone', onCameraWarning });

    await waitFor(() => expect(dispatch).toHaveBeenCalledWith({ type: 'PERMISSION_GRANTED' }));
    expect(getUserMedia.mock.calls[1]?.[0].video).toMatchObject({ facingMode: 'environment' });
    expect(onCameraWarning).toHaveBeenCalledWith(
      'That camera isn’t available — using the usual one instead.',
    );
  });

  it('still fails when there was no remembered camera to fall back from', async () => {
    const getUserMedia = vi.fn().mockRejectedValue(new DOMException('nope', 'NotAllowedError'));
    Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia } });
    const dispatch = vi.fn();

    renderScanner('REQUESTING_PERMISSIONS', dispatch);

    await waitFor(() =>
      expect(dispatch).toHaveBeenCalledWith({
        type: 'PERMISSION_DENIED',
        message: 'Camera access was denied. Allow it in your browser, or enter codes manually.',
      }),
    );
    expect(getUserMedia).toHaveBeenCalledTimes(1);
  });

  it('re-requests through the one acquisition path when the choice changes mid-scan', async () => {
    const stop = vi.fn();
    mockCamera(fakeStream([{ stop }]));
    const dispatch = vi.fn();

    const { rerender } = renderScanner('STREAM_ACTIVE', dispatch);
    // Reaching STREAM_ACTIVE in the app goes through REQUESTING_PERMISSIONS, so drive that first
    // to get a live stream, then hand the hook a different camera.
    rerender({ status: 'REQUESTING_PERMISSIONS', cameraId: '' });
    await waitFor(() => expect(dispatch).toHaveBeenCalledWith({ type: 'PERMISSION_GRANTED' }));

    rerender({ status: 'STREAM_ACTIVE', cameraId: 'cam-tele' });

    await waitFor(() => expect(dispatch).toHaveBeenCalledWith({ type: 'REOPEN' }));
    // The old track must be released first — many devices refuse to open a second camera while one
    // is live.
    expect(stop).toHaveBeenCalled();
  });

  it('reports the device’s cameras once a stream is live, surviving the grant’s own re-render', async () => {
    // The regression this pins: granting permission moves the machine to STREAM_ACTIVE, which
    // re-runs the acquisition effect and cancels it a beat later — every single time. Anything the
    // grant starts asynchronously must be guarded on the *stream*, not on that cancellation, or the
    // picker silently never appears.
    mockCamera(fakeStream([{ stop: vi.fn(), getSettings: () => ({ deviceId: 'cam-wide' }) }]), [
      { kind: 'videoinput', deviceId: 'cam-wide', label: 'Back Ultra Wide Camera' },
      { kind: 'videoinput', deviceId: 'cam-main', label: 'Back Camera' },
    ]);

    const { result } = renderWiredToMachine();

    await waitFor(() => expect(result.current.status).toBe('STREAM_ACTIVE'));
    await waitFor(() =>
      expect(result.current.camera.cameras).toEqual([
        { deviceId: 'cam-wide', label: 'Back Ultra Wide Camera' },
        { deviceId: 'cam-main', label: 'Back Camera' },
      ]),
    );
    // And the picker's checked row follows the track, not the request.
    expect(result.current.camera.activeCameraId).toBe('cam-wide');
  });

  it('does not re-request when the live camera already is the chosen one', async () => {
    const dispatch = vi.fn();
    const getUserMedia = mockCamera();
    const { rerender } = renderScanner('REQUESTING_PERMISSIONS', vi.fn(), null, { cameraId: 'cam-tele' });
    await waitFor(() => expect(getUserMedia).toHaveBeenCalled());
    rerender({ status: 'STREAM_ACTIVE', cameraId: 'cam-tele' });

    // A status flip into the live view is not a camera change; re-acquiring here would restart the
    // camera on every review ⇄ scanning toggle.
    expect(dispatch).not.toHaveBeenCalledWith({ type: 'REOPEN' });
  });
});

describe('useScanner — the torch', () => {
  /** A track advertising a torch, recording what the toggle applies to it. */
  function torchTrack(applyConstraints = vi.fn().mockResolvedValue(undefined)) {
    return { stop: vi.fn(), getCapabilities: () => ({ torch: true }), applyConstraints };
  }

  it('offers no torch until a stream is live, nor for a camera without one', async () => {
    const getUserMedia = mockCamera();
    const { result } = renderScanner('REQUESTING_PERMISSIONS', vi.fn());

    expect(result.current.torch.supported).toBe(false);
    await waitFor(() => expect(getUserMedia).toHaveBeenCalled());
    expect(result.current.torch.supported).toBe(false);
  });

  it('offers the torch where the camera advertises one, and follows an accepted switch', async () => {
    const applyConstraints = vi.fn().mockResolvedValue(undefined);
    mockCamera(fakeStream([torchTrack(applyConstraints)]));
    const { result } = renderScanner('REQUESTING_PERMISSIONS', vi.fn());

    await waitFor(() => expect(result.current.torch.supported).toBe(true));
    expect(result.current.torch.on).toBe(false);

    result.current.torch.toggle();

    await waitFor(() => expect(result.current.torch.on).toBe(true));
    expect(applyConstraints).toHaveBeenCalledWith({ advanced: [{ torch: true }] });
  });

  it('stays off — and says why — when the camera refuses', async () => {
    // A toggle that flipped regardless would show a lit torch over a dark frame.
    const onCameraWarning = vi.fn();
    mockCamera(fakeStream([torchTrack(vi.fn().mockRejectedValue(new Error('busy')))]));
    const { result } = renderScanner('REQUESTING_PERMISSIONS', vi.fn(), null, { onCameraWarning });

    await waitFor(() => expect(result.current.torch.supported).toBe(true));
    result.current.torch.toggle();

    await waitFor(() =>
      expect(onCameraWarning).toHaveBeenCalledWith(
        'The torch couldn’t be switched on. Another app may be using the camera.',
      ),
    );
    expect(result.current.torch.on).toBe(false);
  });

  it('forgets the torch when the stream stops, so a dead camera never reads as lit', async () => {
    mockCamera(fakeStream([torchTrack()]));
    const dispatch = vi.fn();
    const { result, rerender } = renderScanner('REQUESTING_PERMISSIONS', dispatch);

    await waitFor(() => expect(result.current.torch.supported).toBe(true));
    result.current.torch.toggle();
    await waitFor(() => expect(result.current.torch.on).toBe(true));

    rerender({ status: 'IDLE', cameraId: undefined });

    await waitFor(() => expect(result.current.torch.supported).toBe(false));
    expect(result.current.torch.on).toBe(false);
  });
});
