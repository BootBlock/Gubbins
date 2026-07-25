import { describe, it, expect, vi, afterEach } from 'vitest';
import { buildVideoConstraints, listCameras, toCameraOptions } from './camera-devices';

/**
 * Which camera the live scanner opens (issue #135). A phone's default rear lens is frequently the
 * ultra-wide, which cannot focus at barcode-reading distance, so the user has to be able to name a
 * camera — and a named camera has to survive being remembered. These pin the two pure decisions
 * plus the guarded enumeration around them.
 */

/** A `MediaDeviceInfo`-shaped stand-in (the real interface has methods we never call). */
function device(kind: string, deviceId: string, label = ''): MediaDeviceInfo {
  return { kind, deviceId, label, groupId: 'g' } as unknown as MediaDeviceInfo;
}

describe('toCameraOptions — enumerated devices → pickable cameras', () => {
  it('keeps video inputs in the platform’s own order, with their labels', () => {
    expect(
      toCameraOptions([
        device('audioinput', 'mic-1', 'Microphone'),
        device('videoinput', 'cam-back', 'Back Camera'),
        device('videoinput', 'cam-front', 'Front Camera'),
        device('audiooutput', 'spk-1', 'Speakers'),
      ]),
    ).toEqual([
      { deviceId: 'cam-back', label: 'Back Camera' },
      { deviceId: 'cam-front', label: 'Front Camera' },
    ]);
  });

  it('drops the blank-id placeholder a browser lists before permission is granted', () => {
    // Such an entry cannot be requested, so offering it as a choice would be a dead row.
    expect(toCameraOptions([device('videoinput', ''), device('videoinput', 'cam-1', 'Camera')])).toEqual([
      { deviceId: 'cam-1', label: 'Camera' },
    ]);
  });

  it('reports an unnamed camera with an empty label, for the caller to name positionally', () => {
    expect(toCameraOptions([device('videoinput', 'cam-1', '   ')])).toEqual([
      { deviceId: 'cam-1', label: '' },
    ]);
  });

  it('de-duplicates a device id and tolerates a missing list', () => {
    expect(toCameraOptions([device('videoinput', 'cam-1', 'A'), device('videoinput', 'cam-1', 'A')])).toEqual(
      [{ deviceId: 'cam-1', label: 'A' }],
    );
    expect(toCameraOptions(null)).toEqual([]);
    expect(toCameraOptions(undefined)).toEqual([]);
  });
});

describe('buildVideoConstraints — chosen camera → getUserMedia constraints', () => {
  it('names the chosen camera exactly, so the user’s pick is honoured not approximated', () => {
    expect(buildVideoConstraints('cam-back')).toEqual({
      deviceId: { exact: 'cam-back' },
      width: { ideal: 1920 },
      height: { ideal: 1080 },
    });
  });

  it('asks for a rear camera when nothing is chosen (the first-run default)', () => {
    const expected = { facingMode: 'environment', width: { ideal: 1920 }, height: { ideal: 1080 } };
    expect(buildVideoConstraints(null)).toEqual(expected);
    expect(buildVideoConstraints('')).toEqual(expected);
    expect(buildVideoConstraints(undefined)).toEqual(expected);
  });

  it('keeps the resolution ask `ideal` either way, so a modest camera still opens (issue #58)', () => {
    for (const constraints of [buildVideoConstraints('cam-1'), buildVideoConstraints(null)]) {
      expect(constraints.width).toEqual({ ideal: 1920 });
      expect(constraints.height).toEqual({ ideal: 1080 });
    }
  });
});

describe('listCameras — the guarded enumeration', () => {
  afterEach(() => {
    Reflect.deleteProperty(navigator, 'mediaDevices');
  });

  function mockDevices(value: unknown) {
    Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value });
  }

  it('reports the enumerated cameras', async () => {
    mockDevices({ enumerateDevices: vi.fn().mockResolvedValue([device('videoinput', 'cam-1', 'Back')]) });
    await expect(listCameras()).resolves.toEqual([{ deviceId: 'cam-1', label: 'Back' }]);
  });

  it('offers no cameras rather than throwing where enumeration is unsupported or fails', async () => {
    mockDevices(undefined);
    await expect(listCameras()).resolves.toEqual([]);
    mockDevices({});
    await expect(listCameras()).resolves.toEqual([]);
    mockDevices({ enumerateDevices: vi.fn().mockRejectedValue(new Error('blocked')) });
    await expect(listCameras()).resolves.toEqual([]);
  });
});
