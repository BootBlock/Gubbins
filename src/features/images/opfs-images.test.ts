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
import { saveImageFile, writeImageFiles, type OpfsImageFile } from './opfs-images';

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

/** `n` files named `image-0.webp`, `image-1.webp`, … */
function images(n: number): OpfsImageFile[] {
  return Array.from({ length: n }, (_, i) => ({ name: `image-${i}.webp`, bytes: new Uint8Array([i]) }));
}

/**
 * A stand-in OPFS `images/` directory, faithful on the point that matters here: opening a
 * handle with `create: true` mints the (empty) directory entry immediately, before any byte is
 * written, and only `close()` commits the staged bytes to it.
 *
 * `failWrite` / `failClose` name the files whose stream misbehaves — a full disk fails the
 * write, and a write that succeeded can still fail to commit on close.
 */
function fakeOpfs(
  options: {
    failWrite?: readonly string[];
    failClose?: readonly string[];
    noDirectory?: boolean;
    /** What opening the directory throws when `noDirectory` is set. */
    directoryFailure?: unknown;
    /** Files already on disk before the run, as if from an earlier restore. */
    existing?: Record<string, Uint8Array>;
  } = {},
) {
  const stored = new Map<string, Uint8Array>(Object.entries(options.existing ?? {}));
  const aborted: string[] = [];

  const dir = {
    getFileHandle: async (name: string, opts?: { create?: boolean }) => {
      if (!stored.has(name)) {
        if (!opts?.create) throw new Error('NotFoundError');
        stored.set(name, new Uint8Array()); // the entry exists from this moment, and is empty
      }
      return {
        getFile: async () => ({ size: stored.get(name)!.length }),
        createWritable: async () => {
          let staged: Uint8Array | undefined;
          return {
            write: async (bytes: Uint8Array) => {
              if (options.failWrite?.includes(name)) throw quotaExceeded();
              staged = bytes;
            },
            close: async () => {
              if (options.failClose?.includes(name)) throw quotaExceeded();
              stored.set(name, staged!);
            },
            // Discards the scratch copy only — whatever the file already held survives.
            abort: async () => {
              aborted.push(name);
            },
          };
        },
      };
    },
    removeEntry: async (name: string) => {
      stored.delete(name);
    },
  };

  vi.stubGlobal('navigator', {
    storage: {
      getDirectory: async () => ({
        getDirectoryHandle: async () => {
          if (options.noDirectory) throw options.directoryFailure ?? new Error('OPFS unavailable');
          return dir;
        },
      }),
    },
  });

  return { stored, aborted };
}

describe('writeImageFiles', () => {
  it('writes every file and reports nothing missed', async () => {
    const { stored } = fakeOpfs();

    const report = await writeImageFiles(images(3));

    expect(report).toEqual({ failed: [], failure: undefined });
    expect([...stored.keys()]).toEqual(['image-0.webp', 'image-1.webp', 'image-2.webp']);
    expect(stored.get('image-1.webp')).toEqual(new Uint8Array([1]));
  });

  it('carries on past a file that will not write, so the rest still land', async () => {
    // Image sizes vary, so the file after the one that exhausted the quota may well still fit —
    // and every file skipped here is one the user has lost for the sake of tidiness.
    const { stored } = fakeOpfs({ failWrite: ['image-1.webp'] });

    const report = await writeImageFiles(images(3));

    expect(report.failed).toEqual(['image-1.webp']);
    expect(report.failure).toMatchObject({ name: 'QuotaExceededError' });
    expect([...stored.keys()]).toEqual(['image-0.webp', 'image-2.webp']);
  });

  it('still raises the storage tier, though it no longer throws (issue #504)', async () => {
    // Swallowing the failure for the caller must not swallow it for the tier: this is a write
    // that genuinely ran out of room, and it is the only authority the estimate does not have.
    const { stored } = fakeOpfs({ failWrite: ['image-0.webp', 'image-1.webp'] });

    await writeImageFiles(images(2));

    expect(onExhausted).toHaveBeenCalledTimes(2);
    expect(stored.size).toBe(0);
  });

  it('aborts the stream of a failed write, rather than leaving its scratch copy holding space', async () => {
    // `close()` on an errored stream rejects in turn, so `abort()` is what releases the swap
    // file — which matters most in the case that put us here.
    const { aborted } = fakeOpfs({ failWrite: ['image-0.webp'] });

    await writeImageFiles(images(2));

    expect(aborted).toEqual(['image-0.webp']);
  });

  it('leaves no empty file behind, which would read as a present-but-broken image', async () => {
    // Opening the handle mints the entry before any byte is written, so a failed write would
    // otherwise leave a 0-byte file — and `readImageBlob` returns an empty blob for that rather
    // than the `undefined` that makes callers fall back to the stored thumbnail.
    const { stored } = fakeOpfs({ failWrite: ['image-0.webp'], failClose: ['image-1.webp'] });

    await writeImageFiles(images(3));

    expect(stored.has('image-0.webp')).toBe(false);
    expect(stored.has('image-1.webp')).toBe(false);
    expect(stored.has('image-2.webp')).toBe(true);
  });

  it('keeps an image the device already had when the write over it fails', async () => {
    // The swap copy never reaches the file, so the old bytes survive the abort — a merge
    // restore that runs out of room must not delete the photos already there.
    const kept = new Uint8Array([9, 9, 9]);
    const { stored } = fakeOpfs({ failWrite: ['image-0.webp'], existing: { 'image-0.webp': kept } });

    const report = await writeImageFiles(images(1));

    expect(report.failed).toEqual(['image-0.webp']);
    expect(stored.get('image-0.webp')).toBe(kept);
  });

  it('does not treat a file whose close failed as written — the bytes commit on close', async () => {
    const { stored } = fakeOpfs({ failClose: ['image-0.webp'] });

    const report = await writeImageFiles(images(2));

    expect(report.failed).toEqual(['image-0.webp']);
    expect(stored.has('image-0.webp')).toBe(false);
    expect(stored.has('image-1.webp')).toBe(true);
  });

  it('reports the whole set instead of throwing when the directory cannot be opened', async () => {
    fakeOpfs({ noDirectory: true });

    const report = await writeImageFiles(images(2));

    expect(report.failed).toEqual(['image-0.webp', 'image-1.webp']);
    expect(report.failure).toMatchObject({ message: 'OPFS unavailable' });
    // OPFS being absent is not a full disk, so the tier must hear nothing about it.
    expect(onExhausted).not.toHaveBeenCalled();
  });

  it('raises the tier when it is the images directory itself that will not fit', async () => {
    // Creating the directory is a write like any other, and it is the first one a restore makes
    // on a device that has never stored a photo — so it is a plausible place to run out.
    fakeOpfs({ noDirectory: true, directoryFailure: quotaExceeded() });

    const report = await writeImageFiles(images(2));

    expect(report.failed).toEqual(['image-0.webp', 'image-1.webp']);
    expect(onExhausted).toHaveBeenCalledTimes(1);
  });

  it('touches OPFS at all only when there is something to write', async () => {
    fakeOpfs({ noDirectory: true });

    expect(await writeImageFiles([])).toEqual({ failed: [] });
  });
});
