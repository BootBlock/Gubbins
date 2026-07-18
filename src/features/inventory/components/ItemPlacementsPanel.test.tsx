import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, within } from '@testing-library/react';
import type { ItemRegionPlacement, LocationPhoto } from '@/db/repositories';
import { serialiseGeometry } from '../regions/geometry';

/**
 * Component tests for {@link ItemPlacementsPanel} — the item side of location regions (issue #81).
 *
 * The react-query seams and the OPFS read are mocked, as everywhere in a component test. The
 * points worth pinning are that the preview stays **read-only** (a viewer must never become a
 * drawing surface), that it highlights only the region the placement is about, and that a photo
 * which never synced degrades to an explanation rather than a broken image.
 */

const h = vi.hoisted(() => ({
  placements: [] as ItemRegionPlacement[],
  photos: [] as LocationPhoto[],
  src: 'blob:photo' as string | null,
  loading: false,
}));

vi.mock('../location-media', () => ({
  useItemPlacements: () => ({ data: h.placements }),
  useLocationPhotos: () => ({ data: h.photos }),
}));

vi.mock('../usePhotoImageSrc', () => ({
  usePhotoImageSrc: () => ({ src: h.src, loading: h.loading }),
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

const renderPanel = () => render(<ItemPlacementsPanel itemId="item-1" />);

beforeEach(() => {
  h.placements = [];
  h.photos = [photo()];
  h.src = 'blob:photo';
  h.loading = false;
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
});
