/**
 * `writeImageFiles` re-hydrates the full-resolution images after a restore has already replaced
 * the database (issue #639), so it is the one OPFS helper that must never throw: by the time it
 * runs there is nothing left to unwind, and abandoning the remaining files on the first failure
 * loses images the device had room for. It reports instead — what landed, and what did not.
 *
 * The rest of the module is exercised by the real-browser smoke test (§8.5.5); this covers the
 * loop's error handling, which is precisely what a happy-path browser run never reaches.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { writeImageFiles, type OpfsImageFile } from './opfs-images';

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
              if (options.failWrite?.includes(name)) throw new Error('QuotaExceededError');
              staged = bytes;
            },
            close: async () => {
              if (options.failClose?.includes(name)) throw new Error('QuotaExceededError');
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
          if (options.noDirectory) throw new Error('OPFS unavailable');
          return dir;
        },
      }),
    },
  });

  return { stored, aborted };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

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
    expect(report.failure).toBeInstanceOf(Error);
    expect([...stored.keys()]).toEqual(['image-0.webp', 'image-2.webp']);
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
    expect(report.failure).toBeInstanceOf(Error);
  });

  it('touches OPFS at all only when there is something to write', async () => {
    fakeOpfs({ noDirectory: true });

    expect(await writeImageFiles([])).toEqual({ failed: [] });
  });
});
