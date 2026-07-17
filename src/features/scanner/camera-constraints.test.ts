import { describe, it, expect, vi } from 'vitest';
import { pickFocusConstraints, applyScannerTrackConstraints } from './camera-constraints';

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
