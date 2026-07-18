import { describe, it, expect, afterEach } from 'vitest';
import { renderHook, cleanup } from '@testing-library/react';
import { useStorageStore, useStoragePersisted } from './useStorageStore';
import { useLabStore } from './useLabStore';

afterEach(() => {
  cleanup();
  useLabStore.getState().resetLab();
});

describe('useStoragePersisted — `storage-persistence-denied` lab flag', () => {
  it('reflects the real persisted state when the flag is off (default)', () => {
    useStorageStore.setState({ persisted: true });
    const { result } = renderHook(() => useStoragePersisted());
    expect(result.current).toBe(true);
  });

  it('reads as not persisted while the flag is on, even though the browser granted it', () => {
    useStorageStore.setState({ persisted: true });
    useLabStore.getState().setFlag('storage-persistence-denied', true);
    const { result } = renderHook(() => useStoragePersisted());
    expect(result.current).toBe(false);
    // The real store value is untouched — only the presentation-facing read is overridden.
    expect(useStorageStore.getState().persisted).toBe(true);
  });

  it('stays false when the flag is on and the browser never granted persistence either', () => {
    useStorageStore.setState({ persisted: false });
    useLabStore.getState().setFlag('storage-persistence-denied', true);
    const { result } = renderHook(() => useStoragePersisted());
    expect(result.current).toBe(false);
  });
});
