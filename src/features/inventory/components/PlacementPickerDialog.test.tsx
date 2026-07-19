import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import type { LocationPhoto, LocationRegionWithCount } from '@/db/repositories';
import { serialiseGeometry } from '../regions/geometry';

/**
 * Component tests for {@link PlacementPickerDialog} — choosing where an item sits, from the
 * item's side (issue #392).
 *
 * What matters here is what the picker *won't* do as much as what it will: it offers regions
 * of the item's location **and its ancestors** (a drawer's region is drawn on a photo of the
 * cabinet), it never edits a region, and it refuses to commit a placement the item already
 * has — which would be a write that changes nothing while reading as if it did.
 */

const h = vi.hoisted(() => ({
  photos: [] as LocationPhoto[],
  regions: [] as LocationRegionWithCount[],
  requestedLocationIds: [] as string[],
}));

vi.mock('../location-media', () => ({
  useLocationPhotosFor: (ids: readonly string[]) => {
    h.requestedLocationIds = [...ids];
    return { data: h.photos, pending: false };
  },
  usePhotoRegions: () => ({ data: h.regions }),
}));

vi.mock('../usePhotoImageSrc', () => ({
  usePhotoImageSrc: () => ({ src: 'blob:photo', loading: false }),
}));

vi.mock('../queries', () => ({
  useLocations: () => ({
    data: {
      rows: [
        { id: 'workshop', name: 'Workshop', parentId: null },
        { id: 'cabinet', name: 'Cabinet A', parentId: 'workshop' },
        { id: 'drawer', name: 'Drawer 3', parentId: 'cabinet' },
      ],
    },
  }),
}));

import { PlacementPickerDialog } from './PlacementPickerDialog';

const photo = (overrides: Partial<LocationPhoto> = {}): LocationPhoto => ({
  id: 'photo-1',
  locationId: 'cabinet',
  caption: 'Left-hand cabinet',
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

const region = (overrides: Partial<LocationRegionWithCount> = {}): LocationRegionWithCount => ({
  id: 'r1',
  photoId: 'photo-1',
  name: 'Bay 2',
  shape: 'rect',
  geometry: serialiseGeometry({ shape: 'rect', x: 0.1, y: 0.1, w: 0.3, h: 0.3 }),
  color: null,
  position: 0,
  itemCount: 0,
  createdAt: 0,
  updatedAt: 0,
  ...overrides,
});

const onChoose = vi.fn();

const renderPicker = (props: Partial<Parameters<typeof PlacementPickerDialog>[0]> = {}) =>
  render(
    <PlacementPickerDialog
      open
      onClose={vi.fn()}
      locationId="drawer"
      from={null}
      placedRegionIds={new Set()}
      onChoose={onChoose}
      {...props}
    />,
  );

beforeEach(() => {
  h.photos = [photo()];
  h.regions = [region()];
  h.requestedLocationIds = [];
  onChoose.mockReset();
});
afterEach(cleanup);

describe('PlacementPickerDialog', () => {
  it('offers photos of the item’s location and of every location above it', () => {
    renderPicker();
    // Nearest first — the drawer's own photos lead, the room's come last.
    expect(h.requestedLocationIds).toEqual(['drawer', 'cabinet', 'workshop']);
  });

  it('labels a photo by its location’s full path, so two "shelf" photos are tellable apart', () => {
    renderPicker();
    expect(
      screen.getByText('Workshop / Cabinet A — Left-hand cabinet', { exact: false }),
    ).toBeInTheDocument();
  });

  it('falls back to numbering a photo that has no caption', () => {
    h.photos = [photo({ caption: null })];
    renderPicker();
    expect(screen.getByText('Workshop / Cabinet A — photo 1', { exact: false })).toBeInTheDocument();
  });

  it('hands the chosen region back with the photo it belongs to', () => {
    renderPicker();
    fireEvent.click(screen.getByTestId('placement-region-choice'));
    fireEvent.click(screen.getByTestId('placement-confirm'));
    expect(onChoose).toHaveBeenCalledWith({ photoId: 'photo-1', regionId: 'r1' }, 'Bay 2');
  });

  it('cannot be confirmed until a region is chosen', () => {
    renderPicker();
    expect(screen.getByTestId('placement-confirm')).toBeDisabled();
  });

  it('shows a region the item is already in, but will not let it be chosen again', () => {
    renderPicker({ placedRegionIds: new Set(['r1']) });
    const choice = screen.getByTestId('placement-region-choice');
    expect(choice).toBeDisabled();
    expect(choice).toHaveTextContent('Already placed here');
  });

  it('keeps the region a move started from choosable — re-picking it just cancels the move', () => {
    renderPicker({
      placedRegionIds: new Set(['r1']),
      from: { photoId: 'photo-1', regionId: 'r1' },
    });
    expect(screen.getByTestId('placement-region-choice')).toBeEnabled();
  });

  it('explains an empty photo rather than offering nothing at all', () => {
    h.regions = [];
    renderPicker();
    expect(screen.getByTestId('placement-no-regions')).toHaveTextContent(
      'No regions have been drawn on this photo yet.',
    );
  });

  it('says where photos come from when neither the location nor its ancestors have any', () => {
    h.photos = [];
    renderPicker();
    expect(screen.getByTestId('placement-picker-no-photos')).toHaveTextContent(
      'Add one from the location’s Photos tab first.',
    );
  });

  it('refuses an already-placed region picked from the canvas, not just from the list', () => {
    renderPicker({ placedRegionIds: new Set(['r1']) });
    // The list row is disabled, but a shape on the photo has no disabled state — so the guard
    // has to live on the selection itself, or clicking the shape would re-enable the write.
    fireEvent.click(screen.getByRole('button', { name: 'Bay 2' }));
    expect(screen.getByTestId('placement-confirm')).toBeDisabled();
  });

  it('clears the choice when the canvas reports a press on blank photo', () => {
    // jsdom lays nothing out, so the canvas treats every press as unmeasurable and ignores it.
    // One honest rectangle (the photo is 400×300, so a client pixel is a display pixel) is what
    // makes the pointer path reachable at all; the geometry maths is covered in its own module.
    const box = { x: 0, y: 0, left: 0, top: 0, right: 400, bottom: 300, width: 400, height: 300 };
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue(box as DOMRect);
    try {
      renderPicker();
      fireEvent.click(screen.getByTestId('placement-region-choice'));
      expect(screen.getByTestId('placement-confirm')).toBeEnabled();
      // The region occupies the top-left 10–40%; (380, 280) is well clear of it.
      fireEvent.pointerDown(screen.getByTestId('region-canvas-surface'), {
        clientX: 380,
        clientY: 280,
      });
      expect(screen.getByTestId('placement-confirm')).toBeDisabled();
    } finally {
      vi.restoreAllMocks();
    }
  });

  it('never offers to edit the regions themselves — that stays in the photo editor', () => {
    renderPicker();
    // No drawing handles, and no rename/delete affordances anywhere in the dialog.
    expect(document.querySelector('[data-handle]')).toBeNull();
    expect(screen.queryByTestId('region-editor-panel')).toBeNull();
  });
});
