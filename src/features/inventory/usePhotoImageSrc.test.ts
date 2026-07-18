import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { usePhotoImageSrc } from './usePhotoImageSrc';

/**
 * The object-URL lifecycle is the part of this hook worth pinning: every location photo opened
 * allocates a blob URL, and a missed `revokeObjectURL` leaks it for the lifetime of the tab —
 * invisibly, since nothing renders differently. The awkward case is a read that resolves *after*
 * the effect was torn down, where a naive implementation allocates a URL nobody will ever revoke.
 *
 * The OPFS reader is faked so the three-step fallback (full-res → thumbnail → nothing) can be
 * driven deterministically, including the read-failure branch.
 */
const readImageBlob = vi.hoisted(() => vi.fn<(path: string) => Promise<Blob | undefined>>());
vi.mock('@/features/images/opfs-images', () => ({ readImageBlob }));

const FULL_RES = new Blob(['full'], { type: 'image/webp' });
const PHOTO = { fullResOpfsPath: 'images/shelf.webp', thumbnailBlob: new Uint8Array([1, 2, 3]) };

let created: string[];
let revoked: string[];

beforeEach(() => {
  created = [];
  revoked = [];
  let n = 0;
  vi.stubGlobal('URL', {
    ...URL,
    createObjectURL: vi.fn(() => {
      const url = `blob:test/${(n += 1)}`;
      created.push(url);
      return url;
    }),
    revokeObjectURL: vi.fn((url: string) => void revoked.push(url)),
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  readImageBlob.mockReset();
});

describe('usePhotoImageSrc', () => {
  it('prefers the full-resolution OPFS file', async () => {
    readImageBlob.mockResolvedValue(FULL_RES);
    const { result } = renderHook(() => usePhotoImageSrc(PHOTO));

    await waitFor(() => expect(result.current.src).not.toBeNull());
    expect(readImageBlob).toHaveBeenCalledWith('images/shelf.webp');
    expect(result.current.loading).toBe(false);
    expect(created).toHaveLength(1);
  });

  // The expected case on a peer device: only the thumbnail syncs, the raw bytes never do.
  it('falls back to the stored thumbnail when the full-resolution file is absent', async () => {
    readImageBlob.mockResolvedValue(undefined);
    const { result } = renderHook(() => usePhotoImageSrc(PHOTO));

    await waitFor(() => expect(result.current.src).not.toBeNull());
    expect(created).toHaveLength(1);
  });

  it('treats a read failure exactly like a missing file rather than throwing', async () => {
    readImageBlob.mockRejectedValue(new Error('OPFS unavailable'));
    const { result } = renderHook(() => usePhotoImageSrc(PHOTO));

    await waitFor(() => expect(result.current.src).not.toBeNull());
    expect(created).toHaveLength(1);
  });

  it('yields no source, and allocates nothing, when neither rendition exists', async () => {
    readImageBlob.mockResolvedValue(undefined);
    const { result } = renderHook(() =>
      usePhotoImageSrc({ fullResOpfsPath: 'images/gone.webp', thumbnailBlob: null }),
    );

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.src).toBeNull();
    expect(created).toEqual([]);
  });

  it('revokes the object URL on unmount', async () => {
    readImageBlob.mockResolvedValue(FULL_RES);
    const { result, unmount } = renderHook(() => usePhotoImageSrc(PHOTO));

    await waitFor(() => expect(result.current.src).not.toBeNull());
    const url = result.current.src!;
    unmount();
    expect(revoked).toContain(url);
  });

  // The leak that is easiest to write and hardest to see: unmounting mid-read must not leave a
  // URL allocated by a callback that runs after the cleanup already ran.
  it('allocates nothing when the read resolves after unmount', async () => {
    let release!: (blob: Blob) => void;
    readImageBlob.mockReturnValue(
      new Promise<Blob | undefined>((resolve) => {
        release = resolve as (blob: Blob) => void;
      }),
    );

    const { unmount } = renderHook(() => usePhotoImageSrc(PHOTO));
    unmount();
    release(FULL_RES);
    await Promise.resolve();
    await Promise.resolve();

    expect(created).toEqual([]);
    expect(revoked).toEqual([]);
  });

  it('revokes the previous URL when the photo changes', async () => {
    readImageBlob.mockResolvedValue(FULL_RES);
    const { result, rerender } = renderHook((photo: typeof PHOTO) => usePhotoImageSrc(photo), {
      initialProps: PHOTO,
    });

    await waitFor(() => expect(result.current.src).not.toBeNull());
    const first = result.current.src!;

    rerender({ fullResOpfsPath: 'images/other.webp', thumbnailBlob: null });
    await waitFor(() => expect(result.current.src).not.toBe(first));

    expect(revoked).toContain(first);
  });

  it('reads nothing for a null photo', async () => {
    const { result } = renderHook(() => usePhotoImageSrc(null));

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.src).toBeNull();
    expect(readImageBlob).not.toHaveBeenCalled();
  });
});
