import { describe, it, expect, vi, afterEach } from 'vitest';
import { renderHook, act, cleanup } from '@testing-library/react';
import { useNfcWrite } from './useNfcWrite';
import type { NdefWriteOptions, NdefWriteRecord } from './nfc-reader';

type Deferred = { resolve: () => void; reject: (error: unknown) => void };

/** A controllable fake `NDEFReader` whose `write()` promise the test resolves/rejects by hand. */
function installFakeReader() {
  let deferred: Deferred | undefined;
  const write = vi.fn(
    (_message: { records: readonly NdefWriteRecord[] } | string, _options?: NdefWriteOptions) =>
      new Promise<void>((resolve, reject) => {
        deferred = { resolve, reject };
      }),
  );
  class FakeReader {
    write = write;
    scan = vi.fn(async () => {});
    addEventListener = vi.fn();
    removeEventListener = vi.fn();
  }
  (globalThis as { NDEFReader?: unknown }).NDEFReader = FakeReader;
  return { write, settle: () => deferred! };
}

function uninstallReader() {
  delete (globalThis as { NDEFReader?: unknown }).NDEFReader;
}

afterEach(() => {
  cleanup();
  uninstallReader();
  vi.restoreAllMocks();
});

describe('useNfcWrite', () => {
  it('reports unsupported when the Web NFC API is absent', () => {
    uninstallReader();
    const { result } = renderHook(() => useNfcWrite());
    expect(result.current.supported).toBe(false);
  });

  it('writes a url record and resolves to success', async () => {
    const { write, settle } = installFakeReader();
    const { result } = renderHook(() => useNfcWrite());
    expect(result.current.supported).toBe(true);

    act(() => result.current.write('https://example.test/Gubbins/#/inventory?item=abc'));
    expect(result.current.status).toBe('writing');
    // The deep-link is written as a single overwrite `url` record.
    expect(write).toHaveBeenCalledTimes(1);
    const [message, options] = write.mock.calls[0]!;
    expect(message).toEqual({
      records: [{ recordType: 'url', data: 'https://example.test/Gubbins/#/inventory?item=abc' }],
    });
    expect(options?.overwrite).toBe(true);

    await act(async () => {
      settle().resolve();
      await Promise.resolve();
    });
    expect(result.current.status).toBe('success');
    expect(result.current.error).toBeNull();
  });

  it('surfaces a friendly error when the write rejects', async () => {
    const { settle } = installFakeReader();
    const { result } = renderHook(() => useNfcWrite());

    act(() => result.current.write('https://example.test/x'));
    await act(async () => {
      const denied = new Error('denied');
      denied.name = 'NotAllowedError';
      settle().reject(denied);
      await Promise.resolve();
    });
    expect(result.current.status).toBe('error');
    expect(result.current.error).toMatch(/permission|switched off/i);
  });

  it('cancel() returns to idle without surfacing an error', async () => {
    installFakeReader();
    const { result } = renderHook(() => useNfcWrite());

    act(() => result.current.write('https://example.test/x'));
    expect(result.current.status).toBe('writing');
    act(() => result.current.cancel());
    expect(result.current.status).toBe('idle');
    expect(result.current.error).toBeNull();
  });

  it('ignores a second write while one is already armed', () => {
    const { write } = installFakeReader();
    const { result } = renderHook(() => useNfcWrite());

    act(() => result.current.write('https://example.test/a'));
    act(() => result.current.write('https://example.test/b'));
    expect(write).toHaveBeenCalledTimes(1);
  });
});
