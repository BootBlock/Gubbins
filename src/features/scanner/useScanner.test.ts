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

function renderScanner(status: ScannerStatus, dispatch: (action: ScannerAction) => void) {
  const videoRef = { current: null };
  return renderHook(() => useScanner({ videoRef, status, dispatch, onDecode: vi.fn() }));
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
    const stream = { getTracks: () => [] };
    const getUserMedia = vi.fn().mockResolvedValue(stream);
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: { getUserMedia },
    });
    const dispatch = vi.fn();

    renderScanner('REQUESTING_PERMISSIONS', dispatch);

    await waitFor(() => expect(getUserMedia).toHaveBeenCalled());
    await waitFor(() => expect(dispatch).toHaveBeenCalledWith({ type: 'PERMISSION_GRANTED' }));
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
