import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import type { ItemImage } from '@/db/repositories';

/**
 * Characterisation tests for {@link ImageManager} — the item photo grid (spec §4.2).
 *
 * These pin the component's *current* observable contract so the upcoming generalisation
 * (item images → any owner) is provably behaviour-preserving: what the grid renders, the
 * arguments the add/remove mutations receive, the add-tile's file-input wiring, and the
 * busy state. The real §4.2.3 pipeline (compress → OPFS → DB) lives behind the `../media`
 * hooks, which are mocked here per the component-test conventions — a component test has
 * no QueryClient, worker or OPFS.
 */

const h = vi.hoisted(() => ({
  images: [] as ItemImage[],
  isLoading: false,
  addPending: false,
  addImage: vi.fn(),
  removeImage: vi.fn(),
}));

vi.mock('../media', () => ({
  useItemImages: () => ({ data: h.images, isLoading: h.isLoading }),
  useAddItemImage: () => ({ mutate: h.addImage, isPending: h.addPending }),
  useRemoveItemImage: () => ({ mutate: h.removeImage, isPending: false }),
}));

import { ImageManager } from './ImageManager';

const ITEM_ID = 'item-1';

/** Synthetic, COMPLETE image fixture (tests are excluded from tsc). */
const image = (overrides: Partial<ItemImage> = {}): ItemImage => ({
  id: 'img-1',
  itemId: ITEM_ID,
  thumbnailBlob: new Uint8Array([1, 2, 3, 4]),
  fullResOpfsPath: 'images/img-1.webp',
  position: 0,
  createdAt: 0,
  updatedAt: 0,
  fullResDowngradedAt: null,
  ...overrides,
});

function renderManager() {
  return render(<ImageManager itemId={ITEM_ID} />);
}

/** The hidden file input behind the dashed add tile. */
const uploadInput = () => screen.getByLabelText('Upload image') as HTMLInputElement;

beforeEach(() => {
  h.images = [];
  h.isLoading = false;
  h.addPending = false;
  h.addImage.mockReset();
  h.removeImage.mockReset();
});
afterEach(cleanup);

describe('ImageManager — grid rendering', () => {
  it('shows the add prompt and the dashed add tile with no images', () => {
    renderManager();
    expect(screen.getByText('Click the dashed tile to add a photo.')).toBeInTheDocument();
    // The add tile is always present — it is the only way to attach a photo.
    const input = uploadInput();
    expect(input).toHaveAttribute('type', 'file');
    expect(input).toHaveAttribute('accept', 'image/*');
    // …and with no images there are no thumbnails or remove buttons at all.
    expect(screen.queryByAltText('Item image')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Remove image' })).not.toBeInTheDocument();
  });

  it('renders one thumbnail tile per stored image, each with its own remove button', () => {
    h.images = [image({ id: 'img-1' }), image({ id: 'img-2' }), image({ id: 'img-3' })];
    renderManager();
    expect(screen.getAllByAltText('Item image')).toHaveLength(3);
    expect(screen.getAllByRole('button', { name: 'Remove image' })).toHaveLength(3);
    // The add tile survives alongside a populated grid.
    expect(uploadInput()).toBeInTheDocument();
  });

  it('tolerates an undefined images query (first render, before data arrives)', () => {
    // @ts-expect-error deliberately exercising the `images ?? []` guard.
    h.images = undefined;
    renderManager();
    expect(screen.queryByAltText('Item image')).not.toBeInTheDocument();
    expect(uploadInput()).toBeInTheDocument();
  });

  it('falls back to the placeholder glyph for an image with no thumbnail bytes', () => {
    h.images = [image({ id: 'img-blank', thumbnailBlob: null })];
    renderManager();
    // Thumbnail renders its placeholder rather than an <img> when there are no bytes.
    expect(screen.queryByAltText('Item image')).not.toBeInTheDocument();
    // The tile (and so its remove control) is still there.
    expect(screen.getByRole('button', { name: 'Remove image' })).toBeInTheDocument();
  });
});

describe('ImageManager — adding a photo', () => {
  it('dispatches the picked file with the owning item id', () => {
    renderManager();
    const file = new File(['fake-bytes'], 'bench.png', { type: 'image/png' });
    fireEvent.change(uploadInput(), { target: { files: [file] } });

    expect(h.addImage).toHaveBeenCalledTimes(1);
    expect(h.addImage).toHaveBeenCalledWith({ itemId: ITEM_ID, file });
  });

  it('clears the input so re-picking the same file fires again', () => {
    renderManager();
    const file = new File(['fake-bytes'], 'bench.png', { type: 'image/png' });
    const input = uploadInput();
    fireEvent.change(input, { target: { files: [file] } });
    expect(input.value).toBe('');
  });

  it('does nothing when the picker is dismissed without a file', () => {
    renderManager();
    fireEvent.change(uploadInput(), { target: { files: [] } });
    expect(h.addImage).not.toHaveBeenCalled();
  });
});

describe('ImageManager — removing a photo', () => {
  it('removes the clicked image by id, scoped to its item', () => {
    h.images = [image({ id: 'img-1' }), image({ id: 'img-2' })];
    renderManager();
    fireEvent.click(screen.getAllByRole('button', { name: 'Remove image' })[1]!);
    expect(h.removeImage).toHaveBeenCalledWith({ id: 'img-2', itemId: ITEM_ID });
  });

  it('uses a type="button" control so it never submits a surrounding form', () => {
    h.images = [image()];
    renderManager();
    expect(screen.getByRole('button', { name: 'Remove image' })).toHaveAttribute('type', 'button');
  });
});

describe('ImageManager — busy state', () => {
  it('shows the upload glyph (no spinner) when idle', () => {
    renderManager();
    expect(screen.queryByRole('status', { name: 'Loading' })).not.toBeInTheDocument();
  });

  it('swaps the add tile for a spinner while an add is in flight', () => {
    h.addPending = true;
    renderManager();
    expect(screen.getByRole('status', { name: 'Loading' })).toBeInTheDocument();
    // The input stays mounted and enabled — only the glyph changes.
    expect(uploadInput()).toBeInTheDocument();
    expect(uploadInput()).toBeEnabled();
  });

  it('also shows the spinner while the images query is loading', () => {
    h.isLoading = true;
    renderManager();
    expect(screen.getByRole('status', { name: 'Loading' })).toBeInTheDocument();
  });
});
