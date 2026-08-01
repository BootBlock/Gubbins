/**
 * Issue #504: the full-resolution WebP is the largest thing Gubbins writes, and it goes straight to
 * OPFS on the main thread — nowhere near the database worker. A `QuotaExceededError` here used to
 * propagate to a toast and stop, leaving the storage tier (and so the banners, Triage and the Hard
 * Stop) computed purely from an estimate the browser is entitled to pad.
 *
 * OPFS itself is not available under happy-dom, so the File System Access chain is faked: what is
 * under test is this module's failure handling, which a real OPFS would only make harder to drive.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setStorageOutcomeObserver } from '@/features/storage/exhaustion';
import { saveImageFile } from './opfs-images';

type FailurePoint = 'write' | 'close' | null;

class FakeWritable {
  aborted = false;
  closed = false;
  readonly chunks: unknown[] = [];

  constructor(
    private readonly failAt: FailurePoint,
    private readonly error: unknown,
  ) {}

  async write(chunk: unknown): Promise<void> {
    if (this.failAt === 'write') throw this.error;
    this.chunks.push(chunk);
  }

  async close(): Promise<void> {
    // A real stream that already errored refuses to close, which is exactly how the underlying
    // failure used to get masked when `close()` ran from a `finally`.
    if (this.failAt === 'close') throw this.error;
    if (this.failAt === 'write') throw new DOMException('stream is errored', 'InvalidStateError');
    this.closed = true;
  }

  async abort(): Promise<void> {
    this.aborted = true;
  }
}

let writable: FakeWritable;

/** Stub OPFS so `saveImageFile` reaches a writable that fails where the test wants it to. */
function stubOpfs(failAt: FailurePoint, error: unknown = quotaExceeded()): void {
  writable = new FakeWritable(failAt, error);
  const fileHandle = { createWritable: () => Promise.resolve(writable) };
  const imagesDir = { getFileHandle: () => Promise.resolve(fileHandle) };
  const root = { getDirectoryHandle: () => Promise.resolve(imagesDir) };
  vi.stubGlobal('navigator', { storage: { getDirectory: () => Promise.resolve(root) } });
}

function quotaExceeded(): DOMException {
  return new DOMException('The quota has been exceeded.', 'QuotaExceededError');
}

const onExhausted = vi.fn();

beforeEach(() => {
  onExhausted.mockClear();
  setStorageOutcomeObserver({ onExhausted, onWriteSucceeded: vi.fn() });
});

afterEach(() => {
  setStorageOutcomeObserver(null);
  vi.unstubAllGlobals();
});

describe('saveImageFile — running out of space', () => {
  it('stores the blob and returns its relative path when there is room', async () => {
    stubOpfs(null);
    await expect(saveImageFile(new Blob(['x']))).resolves.toMatch(/^images\/.+\.webp$/);
    expect(writable.closed).toBe(true);
    expect(onExhausted).not.toHaveBeenCalled();
  });

  it('reports a quota failure raised by close(), where OPFS usually surfaces one', async () => {
    // OPFS *stages* a write, so the quota check normally lands at close() rather than at write().
    stubOpfs('close');
    await expect(saveImageFile(new Blob(['x']))).rejects.toMatchObject({ name: 'QuotaExceededError' });
    expect(onExhausted).toHaveBeenCalledTimes(1);
  });

  it('reports a quota failure raised by write(), without close() masking it', async () => {
    stubOpfs('write');
    await expect(saveImageFile(new Blob(['x']))).rejects.toMatchObject({ name: 'QuotaExceededError' });
    expect(onExhausted).toHaveBeenCalledTimes(1);
  });

  it('discards the staged bytes rather than committing a partial file on a full device', async () => {
    stubOpfs('close');
    await expect(saveImageFile(new Blob(['x']))).rejects.toThrow();
    expect(writable.aborted).toBe(true);
    expect(writable.closed).toBe(false);
  });

  it('rethrows a failure that has nothing to do with space without raising the tier', async () => {
    stubOpfs('close', new DOMException('gone', 'NotFoundError'));
    await expect(saveImageFile(new Blob(['x']))).rejects.toMatchObject({ name: 'NotFoundError' });
    expect(onExhausted).not.toHaveBeenCalled();
  });
});
