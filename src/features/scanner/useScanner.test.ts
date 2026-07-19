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
import { useScanner } from './useScanner';
import type { ScannerAction, ScannerStatus } from './scanner-machine';
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
) {
  const videoRef = { current: video };
  return renderHook(() => useScanner({ videoRef, status, dispatch, onDecode: vi.fn() }));
}

/** A video element stand-in whose `play()` resolves or rejects on command. */
function fakeVideo(play: () => Promise<void>) {
  return { srcObject: null, play } as unknown as HTMLVideoElement;
}

function mockCamera(stream: unknown = { getTracks: () => [] }) {
  const getUserMedia = vi.fn().mockResolvedValue(stream);
  Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia } });
  return getUserMedia;
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
