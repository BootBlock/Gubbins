import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, within } from '@testing-library/react';
import { ToastProvider } from '@/components/foundry';
import type { LocationPhoto } from '@/db/repositories';

/**
 * Component tests for {@link LocationPhotoManager} — the location photo grid (issue #81).
 *
 * The react-query seams it reaches for (`../location-media`) are mocked per the component-test
 * conventions: a component test has no QueryClient, worker or OPFS. `RegionEditorDialog` is
 * stubbed to a marker — it owns the canvas, the draw tools and its own queries, and has its own
 * test; what belongs *here* is that the grid opens it for the right photo.
 *
 * The i18n seam runs for real, so the assertions are the English copy a user actually sees.
 */

const h = vi.hoisted(() => ({
  photos: [] as LocationPhoto[],
  isLoading: false,
  addPending: false,
  regionsByPhoto: {} as Record<string, unknown[]>,
  addPhoto: vi.fn(),
  removePhoto: vi.fn(),
  updateCaption: vi.fn(),
}));

vi.mock('../location-media', () => ({
  useLocationPhotos: () => ({ data: h.photos, isLoading: h.isLoading }),
  useAddLocationPhoto: () => ({ mutate: h.addPhoto, isPending: h.addPending }),
  useRemoveLocationPhoto: () => ({ mutate: h.removePhoto, isPending: false }),
  useUpdatePhotoCaption: () => ({ mutate: h.updateCaption, isPending: false }),
  usePhotoRegions: (photoId: string) => ({ data: h.regionsByPhoto[photoId] ?? [] }),
}));

vi.mock('./RegionEditorDialog', () => ({
  RegionEditorDialog: ({ open, photo }: { open: boolean; photo: LocationPhoto }) =>
    open ? <div data-testid="mock-region-editor">{photo.id}</div> : null,
}));

import { LocationPhotoManager } from './LocationPhotoManager';

const LOCATION_ID = 'loc-1';

/** Synthetic, COMPLETE photo fixture (tests are excluded from tsc). */
const photo = (overrides: Partial<LocationPhoto> = {}): LocationPhoto => ({
  id: 'photo-1',
  locationId: LOCATION_ID,
  caption: null,
  thumbnailBlob: new Uint8Array([1, 2, 3, 4]),
  fullResOpfsPath: 'images/photo-1.webp',
  fullResDowngradedAt: null,
  naturalWidth: 400,
  naturalHeight: 300,
  position: 0,
  createdAt: 0,
  updatedAt: 0,
  ...overrides,
});

function renderManager() {
  // The manager reports failed writes through a toast, so `useToast()` needs its provider —
  // exactly as it has one under <App>.
  return render(
    <ToastProvider>
      <LocationPhotoManager locationId={LOCATION_ID} locationName="Workshop" />
    </ToastProvider>,
  );
}

const uploadInput = () => screen.getByLabelText('Upload a photo') as HTMLInputElement;
const tiles = () => screen.getAllByTestId('location-photo-tile');

beforeEach(() => {
  h.photos = [];
  h.isLoading = false;
  h.addPending = false;
  h.regionsByPhoto = {};
  h.addPhoto.mockReset();
  h.removePhoto.mockReset();
  h.updateCaption.mockReset();
});
afterEach(cleanup);

describe('LocationPhotoManager — grid rendering', () => {
  it('invites the first photo and offers the add tile when there are none', () => {
    renderManager();
    expect(screen.getByTestId('location-photos-empty')).toHaveTextContent('Add a photo of this location');
    const input = uploadInput();
    expect(input).toHaveAttribute('type', 'file');
    expect(input).toHaveAttribute('accept', 'image/*');
    expect(screen.queryByTestId('location-photo-tile')).not.toBeInTheDocument();
  });

  it('renders one tile per photo, each with a caption field and its own remove control', () => {
    h.photos = [photo({ id: 'p1' }), photo({ id: 'p2' })];
    renderManager();
    expect(tiles()).toHaveLength(2);
    expect(screen.getAllByAltText('Photo of Workshop')).toHaveLength(2);
    expect(screen.getAllByLabelText('Caption (optional)')).toHaveLength(2);
    expect(screen.getAllByRole('button', { name: 'Remove photo' })).toHaveLength(2);
    // The add tile survives alongside a populated grid, and the empty prompt goes away.
    expect(uploadInput()).toBeInTheDocument();
    expect(screen.queryByTestId('location-photos-empty')).not.toBeInTheDocument();
  });

  it('tolerates an undefined photos query (first render, before data arrives)', () => {
    // @ts-expect-error deliberately exercising the `photos ?? []` guard.
    h.photos = undefined;
    renderManager();
    expect(screen.queryByTestId('location-photo-tile')).not.toBeInTheDocument();
    expect(uploadInput()).toBeInTheDocument();
  });

  it('seeds each caption field from the stored caption', () => {
    h.photos = [photo({ id: 'p1', caption: 'Left-hand cabinet' })];
    renderManager();
    expect(screen.getByLabelText('Caption (optional)')).toHaveValue('Left-hand cabinet');
  });

  it('pluralises the region count per photo, so a tile says how much is mapped out', () => {
    h.photos = [photo({ id: 'p1' }), photo({ id: 'p2' }), photo({ id: 'p3' })];
    h.regionsByPhoto = { p1: [], p2: [{}], p3: [{}, {}, {}] };
    renderManager();
    const [first, second, third] = tiles();
    expect(within(first!).getByText('0 regions')).toBeInTheDocument();
    expect(within(second!).getByText('1 region')).toBeInTheDocument();
    expect(within(third!).getByText('3 regions')).toBeInTheDocument();
  });
});

describe('LocationPhotoManager — adding and removing', () => {
  it('dispatches the picked file with the owning location id', () => {
    renderManager();
    const file = new File(['fake-bytes'], 'bench.png', { type: 'image/png' });
    fireEvent.change(uploadInput(), { target: { files: [file] } });
    expect(h.addPhoto).toHaveBeenCalledWith({ locationId: LOCATION_ID, file }, expect.anything());
  });

  it('clears the input so re-picking the same file fires again', () => {
    renderManager();
    const input = uploadInput();
    fireEvent.change(input, { target: { files: [new File(['x'], 'a.png', { type: 'image/png' })] } });
    expect(input.value).toBe('');
  });

  it('does nothing when the picker is dismissed without a file', () => {
    renderManager();
    fireEvent.change(uploadInput(), { target: { files: [] } });
    expect(h.addPhoto).not.toHaveBeenCalled();
  });

  // Deleting a photo takes its regions and every placement on them with it, so it confirms
  // first — the click that opens the prompt must not itself delete anything.
  it('asks before removing a photo, and deletes nothing until confirmed', () => {
    h.photos = [photo({ id: 'p1' }), photo({ id: 'p2' })];
    renderManager();
    fireEvent.click(within(tiles()[1]!).getByRole('button', { name: 'Remove photo' }));

    expect(h.removePhoto).not.toHaveBeenCalled();
    const confirm = within(tiles()[1]!).getByTestId('photo-delete-confirm');
    expect(confirm).toHaveTextContent(/only unplaced/i);

    fireEvent.click(within(confirm).getByRole('button', { name: 'Delete photo' }));
    expect(h.removePhoto).toHaveBeenCalledTimes(1);
    expect(h.removePhoto).toHaveBeenCalledWith({ id: 'p2', locationId: LOCATION_ID }, expect.anything());
  });

  it('abandons the deletion when the prompt is cancelled', () => {
    h.photos = [photo({ id: 'p1' })];
    renderManager();
    fireEvent.click(within(tiles()[0]!).getByRole('button', { name: 'Remove photo' }));
    fireEvent.click(within(tiles()[0]!).getByRole('button', { name: 'Cancel' }));

    expect(h.removePhoto).not.toHaveBeenCalled();
    expect(within(tiles()[0]!).queryByTestId('photo-delete-confirm')).toBeNull();
  });
});

describe('LocationPhotoManager — captions', () => {
  it('saves a changed caption on blur, trimmed', () => {
    h.photos = [photo({ id: 'p1' })];
    renderManager();
    const field = screen.getByLabelText('Caption (optional)');
    fireEvent.change(field, { target: { value: '  Under the bench  ' } });
    // Typing alone must not fire a mutation — that would invalidate the list mid-edit.
    expect(h.updateCaption).not.toHaveBeenCalled();
    fireEvent.blur(field);
    expect(h.updateCaption).toHaveBeenCalledWith(
      { id: 'p1', caption: 'Under the bench', locationId: LOCATION_ID },
      expect.anything(),
    );
  });

  it('normalises a cleared caption to null', () => {
    h.photos = [photo({ id: 'p1', caption: 'Old note' })];
    renderManager();
    const field = screen.getByLabelText('Caption (optional)');
    fireEvent.change(field, { target: { value: '   ' } });
    fireEvent.blur(field);
    expect(h.updateCaption).toHaveBeenCalledWith(
      { id: 'p1', caption: null, locationId: LOCATION_ID },
      expect.anything(),
    );
  });

  it('does not save when the caption is unchanged', () => {
    h.photos = [photo({ id: 'p1', caption: 'Shelf' })];
    renderManager();
    fireEvent.blur(screen.getByLabelText('Caption (optional)'));
    expect(h.updateCaption).not.toHaveBeenCalled();
  });
});

describe('LocationPhotoManager — the region editor', () => {
  it('stays closed until a photo is opened', () => {
    h.photos = [photo({ id: 'p1' })];
    renderManager();
    expect(screen.queryByTestId('mock-region-editor')).not.toBeInTheDocument();
  });

  it('opens the editor for the photo whose control was used', () => {
    h.photos = [photo({ id: 'p1' }), photo({ id: 'p2' })];
    renderManager();
    fireEvent.click(within(tiles()[1]!).getByRole('button', { name: 'Draw regions' }));
    expect(screen.getByTestId('mock-region-editor')).toHaveTextContent('p2');
  });
});
