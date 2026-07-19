import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, within, fireEvent } from '@testing-library/react';
import type { Item, ItemRegionPlacement, LocationPhoto } from '@/db/repositories';
import { serialiseGeometry } from '../regions/geometry';

/**
 * Component tests for {@link ItemPlacementsPanel} — the item side of location regions (issue #81),
 * and the place/move/unplace actions added to it in issue #392.
 *
 * The react-query seams and the OPFS read are mocked, as everywhere in a component test. The
 * points worth pinning are that the preview stays **read-only** (a viewer must never become a
 * drawing surface), that it highlights only the region the placement is about, that a photo
 * which never synced degrades to an explanation rather than a broken image — and that the write
 * actions name both ends of the change, since a move that forgot its `from` end would silently
 * leave the item in two places at once.
 */

const h = vi.hoisted(() => ({
  placements: [] as ItemRegionPlacement[],
  photos: [] as LocationPhoto[],
  src: 'blob:photo' as string | null,
  loading: false,
  setPlacement: vi.fn(),
  toast: vi.fn(),
}));

vi.mock('../location-media', () => ({
  useItemPlacements: () => ({ data: h.placements }),
  useLocationPhotos: () => ({ data: h.photos }),
  useSetItemPlacement: () => ({ mutate: h.setPlacement, isPending: false }),
}));

vi.mock('../usePhotoImageSrc', () => ({
  usePhotoImageSrc: () => ({ src: h.src, loading: h.loading }),
}));

// The picker has its own test; here it only has to be *reachable* and to report a choice back.
vi.mock('./PlacementPickerDialog', () => ({
  PlacementPickerDialog: ({
    from,
    onChoose,
  }: {
    from: { photoId: string; regionId: string } | null;
    onChoose: (target: { photoId: string; regionId: string }, name: string) => void;
  }) => (
    <div data-testid="placement-picker" data-from={from ? from.regionId : 'none'}>
      <button type="button" onClick={() => onChoose({ photoId: 'photo-2', regionId: 'r9' }, 'Bay 4')}>
        choose
      </button>
    </div>
  ),
}));

vi.mock('@/components/foundry', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/components/foundry')>()),
  useToast: () => ({ show: h.toast }),
}));

import { ItemPlacementsPanel } from './ItemPlacementsPanel';

const photo = (overrides: Partial<LocationPhoto> = {}): LocationPhoto => ({
  id: 'photo-1',
  locationId: 'loc-1',
  caption: null,
  thumbnailBlob: null,
  fullResOpfsPath: 'images/photo-1.webp',
  fullResDowngradedAt: null,
  naturalWidth: 400,
  naturalHeight: 300,
  position: 0,
  createdAt: 0,
  updatedAt: 0,
  ...overrides,
});

/** Synthetic, COMPLETE placement fixture (tests are excluded from tsc). */
const placement = (overrides: Partial<ItemRegionPlacement> = {}): ItemRegionPlacement => ({
  regionId: 'r1',
  regionName: 'Top shelf',
  shape: 'rect',
  geometry: serialiseGeometry({ shape: 'rect', x: 0.1, y: 0.1, w: 0.3, h: 0.3 }),
  color: null,
  photoId: 'photo-1',
  locationId: 'loc-1',
  locationName: 'Workshop',
  ...overrides,
});

/** Only `id` and `locationId` are read here; the rest of `Item` is irrelevant to this panel. */
const item = { id: 'item-1', locationId: 'loc-1' } as Item;

const renderPanel = () => render(<ItemPlacementsPanel item={item} />);

beforeEach(() => {
  h.placements = [];
  h.photos = [photo()];
  h.src = 'blob:photo';
  h.loading = false;
  h.setPlacement.mockReset();
  h.toast.mockReset();
});
afterEach(cleanup);

describe('ItemPlacementsPanel', () => {
  it('says the item has not been placed when it belongs to no region', () => {
    renderPanel();
    expect(screen.getByTestId('item-placements-empty')).toHaveTextContent(
      'This item has not been placed on a location photo.',
    );
  });

  it('tolerates an undefined placements query (first render, before data arrives)', () => {
    // @ts-expect-error deliberately exercising the `placements ?? []` guard.
    h.placements = undefined;
    renderPanel();
    expect(screen.getByTestId('item-placements-empty')).toBeInTheDocument();
  });

  it('renders one card per placement, naming the region and its location', () => {
    h.placements = [
      placement(),
      placement({ regionId: 'r2', regionName: 'Drawer 2', locationName: 'Workshop' }),
    ];
    renderPanel();
    const cards = screen.getAllByTestId('item-placement-card');
    expect(cards).toHaveLength(2);
    expect(within(cards[0]!).getByText('Top shelf — Workshop')).toBeInTheDocument();
    expect(within(cards[1]!).getByText('Drawer 2 — Workshop')).toBeInTheDocument();
  });

  it('previews the photo with only this placement’s region drawn on it', () => {
    h.placements = [placement()];
    renderPanel();
    expect(screen.getByAltText('Photo of Workshop')).toHaveAttribute('src', 'blob:photo');
    // Exactly one shape, named for the region — not the whole photo's region set.
    expect(screen.getByRole('button', { name: 'Top shelf' })).toBeInTheDocument();
  });

  it('keeps the preview read-only — no resize handles, whatever the pointer does', () => {
    h.placements = [placement()];
    renderPanel();
    // Handles are the editing-only affordance; `readOnly` defaults to true, so there are none.
    expect(document.querySelector('[data-handle]')).toBeNull();
    expect(screen.getByTestId('region-canvas-surface')).toHaveStyle({ touchAction: '' });
  });

  it('explains a photo whose full-resolution file never reached this device', () => {
    h.src = null;
    h.loading = false;
    h.placements = [placement()];
    renderPanel();
    expect(screen.getByTestId('item-placement-placeholder')).toHaveTextContent(
      'The full-size photo isn’t available on this device.',
    );
    // The region and location are still named — the answer survives the missing picture.
    expect(screen.getByText('Top shelf — Workshop')).toBeInTheDocument();
  });

  it('falls back to the placeholder when the placement points at a photo this location no longer lists', () => {
    h.placements = [placement({ photoId: 'gone' })];
    renderPanel();
    expect(screen.getByTestId('item-placement-placeholder')).toBeInTheDocument();
  });

  // --- Placing, moving and unplacing (issue #392) --------------------------------

  it('offers to place the item even when it sits nowhere yet', () => {
    renderPanel();
    fireEvent.click(screen.getByTestId('item-placement-add'));
    // Adding, not moving: there is no placement to move out of.
    expect(screen.getByTestId('placement-picker')).toHaveAttribute('data-from', 'none');
  });

  it('places the item in the chosen region, with no `from` end', () => {
    renderPanel();
    fireEvent.click(screen.getByTestId('item-placement-add'));
    fireEvent.click(screen.getByText('choose'));
    expect(h.setPlacement).toHaveBeenCalledWith(
      { itemId: 'item-1', from: null, to: { photoId: 'photo-2', regionId: 'r9' } },
      expect.anything(),
    );
  });

  it('moves a placement as one change — out of the old region and into the new', () => {
    h.placements = [placement()];
    renderPanel();
    fireEvent.click(screen.getByTestId('item-placement-move'));
    expect(screen.getByTestId('placement-picker')).toHaveAttribute('data-from', 'r1');
    fireEvent.click(screen.getByText('choose'));
    expect(h.setPlacement).toHaveBeenCalledWith(
      {
        itemId: 'item-1',
        from: { photoId: 'photo-1', regionId: 'r1' },
        to: { photoId: 'photo-2', regionId: 'r9' },
      },
      expect.anything(),
    );
  });

  it('unplaces a placement without placing it anywhere else', () => {
    h.placements = [placement()];
    renderPanel();
    fireEvent.click(screen.getByTestId('item-placement-remove'));
    expect(h.setPlacement).toHaveBeenCalledWith(
      { itemId: 'item-1', from: { photoId: 'photo-1', regionId: 'r1' } },
      expect.anything(),
    );
  });

  it('names the region in each action’s label, so a grid of several is unambiguous', () => {
    h.placements = [placement()];
    renderPanel();
    expect(screen.getByRole('button', { name: 'Move out of Top shelf' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Remove from Top shelf' })).toBeInTheDocument();
  });

  it('reports a failed write rather than leaving the grid silently unchanged', () => {
    h.placements = [placement()];
    h.setPlacement.mockImplementation((_vars, opts) => opts.onError(new Error('disk full')));
    renderPanel();
    fireEvent.click(screen.getByTestId('item-placement-remove'));
    expect(h.toast).toHaveBeenCalledWith(expect.objectContaining({ tone: 'danger' }));
  });

  it('announces an unplacing, which otherwise only removes a picture', () => {
    h.placements = [placement()];
    h.setPlacement.mockImplementation((_vars, opts) => opts.onSuccess());
    renderPanel();
    fireEvent.click(screen.getByTestId('item-placement-remove'));
    expect(screen.getByText('Removed from Top shelf.')).toBeInTheDocument();
  });
});
