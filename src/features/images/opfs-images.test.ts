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
 * A stand-in OPFS `images/` directory. `failWrite` / `failClose` name the files whose stream
 * misbehaves — a full disk fails the write, and a write that succeeded can still fail to commit
 * on close, which is why the count follows the close rather than the write.
 */
function fakeOpfs(
  options: { failWrite?: readonly string[]; failClose?: readonly string[]; noDirectory?: boolean } = {},
) {
  const stored = new Map<string, Uint8Array>();
  const aborted: string[] = [];

  const dir = {
    getFileHandle: async (name: string) => ({
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
          abort: async () => {
            aborted.push(name);
          },
        };
      },
    }),
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

    expect(report).toEqual({ written: 3, failed: [], failure: undefined });
    expect([...stored.keys()]).toEqual(['image-0.webp', 'image-1.webp', 'image-2.webp']);
  });

  it('carries on past a file that will not write, so the rest still land', async () => {
    // Image sizes vary, so the file after the one that exhausted the quota may well still fit —
    // and every file skipped here is one the user has lost for the sake of tidiness.
    const { stored } = fakeOpfs({ failWrite: ['image-1.webp'] });

    const report = await writeImageFiles(images(3));

    expect(report.written).toBe(2);
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

  it('does not count a file whose close failed — the bytes are not committed until then', async () => {
    const { stored } = fakeOpfs({ failClose: ['image-0.webp'] });

    const report = await writeImageFiles(images(2));

    expect(report.written).toBe(1);
    expect(report.failed).toEqual(['image-0.webp']);
    expect(stored.has('image-0.webp')).toBe(false);
  });

  it('reports the whole set instead of throwing when the directory cannot be opened', async () => {
    fakeOpfs({ noDirectory: true });

    const report = await writeImageFiles(images(2));

    expect(report.written).toBe(0);
    expect(report.failed).toEqual(['image-0.webp', 'image-1.webp']);
  });

  it('touches OPFS at all only when there is something to write', async () => {
    fakeOpfs({ noDirectory: true });

    expect(await writeImageFiles([])).toEqual({ written: 0, failed: [] });
  });
});
