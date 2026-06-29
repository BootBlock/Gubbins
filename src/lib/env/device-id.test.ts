import { describe, it, expect } from 'vitest';
import { getDeviceId, DEVICE_ID_KEY } from './device-id';

/** A minimal in-memory Storage stand-in so tests never touch real localStorage. */
function fakeStorage(): Storage {
  const map = new Map<string, string>();
  return {
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => void map.set(k, String(v)),
    removeItem: (k) => void map.delete(k),
    clear: () => map.clear(),
    key: (i) => [...map.keys()][i] ?? null,
    get length() {
      return map.size;
    },
  };
}

describe('getDeviceId', () => {
  it('generates and persists a stable id on first read', () => {
    const storage = fakeStorage();
    const id = getDeviceId(storage);
    expect(id).toMatch(/^[0-9a-f-]{36}$/i);
    expect(storage.getItem(DEVICE_ID_KEY)).toBe(id);
  });

  it('returns the same id on subsequent reads', () => {
    const storage = fakeStorage();
    expect(getDeviceId(storage)).toBe(getDeviceId(storage));
  });

  it('treats distinct storages as distinct devices', () => {
    expect(getDeviceId(fakeStorage())).not.toBe(getDeviceId(fakeStorage()));
  });

  it('reuses a previously persisted id verbatim', () => {
    const storage = fakeStorage();
    storage.setItem(DEVICE_ID_KEY, 'pinned-device-id');
    expect(getDeviceId(storage)).toBe('pinned-device-id');
  });

  it('falls back to a non-empty id when no storage is available', () => {
    const id = getDeviceId(null);
    expect(id).toMatch(/^[0-9a-f-]{36}$/i);
    // memoised within the module, so a second no-storage read is stable
    expect(getDeviceId(null)).toBe(id);
  });
});
