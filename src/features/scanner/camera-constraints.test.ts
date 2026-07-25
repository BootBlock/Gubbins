import { describe, it, expect, vi } from 'vitest';
import {
  pickFocusConstraints,
  applyScannerTrackConstraints,
  applyScannerTorch,
  scannerTorchSupported,
} from './camera-constraints';

/**
 * Best-effort camera-track tuning for the live scanner (issue #59): ask a capable camera for
 * continuous autofocus so a framed barcode stays sharp. The whole path is feature-detected and
 * guarded, so these assert the pure decision plus that the guarded DOM apply never throws.
 */
describe('pickFocusConstraints — capability → advanced constraint decision', () => {
  it('requests continuous focus when the camera advertises it', () => {
    expect(pickFocusConstraints({ focusMode: ['manual', 'continuous', 'single-shot'] })).toEqual([
      { focusMode: 'continuous' },
    ]);
  });

  it('asks for nothing when continuous focus is unsupported or unadvertised', () => {
    expect(pickFocusConstraints({ focusMode: ['manual'] })).toEqual([]);
    expect(pickFocusConstraints({})).toEqual([]);
    expect(pickFocusConstraints(null)).toEqual([]);
    expect(pickFocusConstraints(undefined)).toEqual([]);
  });
});

/** A fake video track whose capabilities/apply behaviour each test controls. */
function fakeTrack(overrides: Partial<Record<'getCapabilities' | 'applyConstraints', unknown>>) {
  return { kind: 'video', ...overrides } as unknown as MediaStreamTrack;
}

function fakeStream(tracks: MediaStreamTrack[]): MediaStream {
  return { getVideoTracks: () => tracks } as unknown as MediaStream;
}

describe('applyScannerTrackConstraints — guarded DOM apply', () => {
  it('applies continuous focus to a capable track', async () => {
    const applyConstraints = vi.fn().mockResolvedValue(undefined);
    const track = fakeTrack({
      getCapabilities: () => ({ focusMode: ['continuous'] }),
      applyConstraints,
    });
    await applyScannerTrackConstraints(fakeStream([track]));
    expect(applyConstraints).toHaveBeenCalledWith({ advanced: [{ focusMode: 'continuous' }] });
  });

  it('applies nothing when the camera advertises no useful capability', async () => {
    const applyConstraints = vi.fn();
    const track = fakeTrack({ getCapabilities: () => ({ focusMode: ['manual'] }), applyConstraints });
    await applyScannerTrackConstraints(fakeStream([track]));
    expect(applyConstraints).not.toHaveBeenCalled();
  });

  it('is a no-op for a track missing the capability/apply methods (older browsers)', async () => {
    await expect(applyScannerTrackConstraints(fakeStream([fakeTrack({})]))).resolves.toBeUndefined();
  });

  it('never throws when getCapabilities throws', async () => {
    const applyConstraints = vi.fn();
    const track = fakeTrack({
      getCapabilities: () => {
        throw new Error('not supported');
      },
      applyConstraints,
    });
    await expect(applyScannerTrackConstraints(fakeStream([track]))).resolves.toBeUndefined();
    expect(applyConstraints).not.toHaveBeenCalled();
  });

  it('never throws when the camera rejects the constraints', async () => {
    const track = fakeTrack({
      getCapabilities: () => ({ focusMode: ['continuous'] }),
      applyConstraints: vi.fn().mockRejectedValue(new Error('busy')),
    });
    await expect(applyScannerTrackConstraints(fakeStream([track]))).resolves.toBeUndefined();
  });

  it('tolerates a stream with no getVideoTracks', async () => {
    await expect(applyScannerTrackConstraints({} as unknown as MediaStream)).resolves.toBeUndefined();
  });
});

/**
 * The torch (issue #135). Inventory lives in badly-lit places, so the camera's own light is the
 * other half of the "why won't this scan?" problem — but the control must only appear, and only
 * claim success, where the camera really has one. A toggle showing a lit torch over a dark frame
 * would be worse than no toggle at all.
 */
describe('scannerTorchSupported', () => {
  it('reports a torch only when the camera advertises one', () => {
    const withTorch = fakeTrack({ getCapabilities: () => ({ torch: true }), applyConstraints: vi.fn() });
    expect(scannerTorchSupported(fakeStream([withTorch]))).toBe(true);
    const without = fakeTrack({
      getCapabilities: () => ({ focusMode: ['continuous'] }),
      applyConstraints: vi.fn(),
    });
    expect(scannerTorchSupported(fakeStream([without]))).toBe(false);
  });

  it('reports none for a track that cannot be probed or applied to, and never throws', () => {
    expect(scannerTorchSupported(fakeStream([fakeTrack({})]))).toBe(false);
    expect(
      scannerTorchSupported(
        fakeStream([
          fakeTrack({
            getCapabilities: () => {
              throw new Error('not supported');
            },
            applyConstraints: vi.fn(),
          }),
        ]),
      ),
    ).toBe(false);
    expect(scannerTorchSupported({} as unknown as MediaStream)).toBe(false);
  });
});

describe('applyScannerTorch', () => {
  it('switches the torch and re-asserts the focus request alongside it', async () => {
    // applyConstraints replaces the track's *whole* constraint set, so applying the torch on its
    // own would silently undo the continuous-autofocus tuning the stream opened with.
    const applyConstraints = vi.fn().mockResolvedValue(undefined);
    const track = fakeTrack({
      getCapabilities: () => ({ torch: true, focusMode: ['continuous'] }),
      applyConstraints,
    });
    await expect(applyScannerTorch(fakeStream([track]), true)).resolves.toBe(true);
    expect(applyConstraints).toHaveBeenCalledWith({
      advanced: [{ focusMode: 'continuous' }, { torch: true }],
    });
  });

  it('switches it back off', async () => {
    const applyConstraints = vi.fn().mockResolvedValue(undefined);
    const track = fakeTrack({ getCapabilities: () => ({ torch: true }), applyConstraints });
    await expect(applyScannerTorch(fakeStream([track]), false)).resolves.toBe(true);
    expect(applyConstraints).toHaveBeenCalledWith({ advanced: [{ torch: false }] });
  });

  it('reports failure — never success — for a camera with focus but no torch', async () => {
    // The give-away bug: applying *something* and calling it a win would light nothing while the
    // toggle claimed otherwise.
    const applyConstraints = vi.fn().mockResolvedValue(undefined);
    const track = fakeTrack({ getCapabilities: () => ({ focusMode: ['continuous'] }), applyConstraints });
    await expect(applyScannerTorch(fakeStream([track]), true)).resolves.toBe(false);
    expect(applyConstraints).not.toHaveBeenCalled();
  });

  it('reports failure when the camera declines, rather than throwing', async () => {
    const track = fakeTrack({
      getCapabilities: () => ({ torch: true }),
      applyConstraints: vi.fn().mockRejectedValue(new Error('busy')),
    });
    await expect(applyScannerTorch(fakeStream([track]), true)).resolves.toBe(false);
  });

  it('reports failure for an unprobeable track and a track-less stream', async () => {
    await expect(applyScannerTorch(fakeStream([fakeTrack({})]), true)).resolves.toBe(false);
    await expect(applyScannerTorch({} as unknown as MediaStream, true)).resolves.toBe(false);
  });
});
