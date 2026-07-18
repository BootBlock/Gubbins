import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, within } from '@testing-library/react';
import type { Item, LocationPhoto, LocationRegionWithCount } from '@/db/repositories';
import { serialiseGeometry } from '../regions/geometry';

/**
 * Component tests for {@link RegionEditorDialog} (issue #81).
 *
 * Every react-query seam is mocked (no QueryClient, worker or OPFS in a component test), as is
 * the OPFS image read — `usePhotoImageSrc` is exercised by the components' own placeholder paths
 * here rather than by faking `readImageBlob`.
 *
 * The focus is the part a pointer test could never reach under jsdom, which lays nothing out
 * (`getBoundingClientRect` is all zeros, `elementFromPoint` is absent): the **region list is the
 * primary, keyboard-complete path**, and the tool doubles as the create-vs-update discriminator.
 */

const h = vi.hoisted(() => ({
  regions: [] as LocationRegionWithCount[],
  regionItemIds: [] as string[],
  itemsById: new Map<string, Item>(),
  candidates: [] as Item[],
  src: 'blob:photo' as string | null,
  loading: false,
  addRegion: vi.fn(),
  updateRegion: vi.fn(),
  removeRegion: vi.fn(),
  link: vi.fn(),
}));

vi.mock('../location-media', () => ({
  usePhotoRegions: () => ({ data: h.regions }),
  useAddRegion: () => ({ mutate: h.addRegion, isPending: false }),
  useUpdateRegion: () => ({ mutate: h.updateRegion, isPending: false }),
  useRemoveRegion: () => ({ mutate: h.removeRegion, isPending: false }),
  useRegionItemIds: () => ({ data: h.regionItemIds }),
  useLinkItemToRegion: () => ({ mutate: h.link, isPending: false }),
}));

vi.mock('../queries', () => ({
  useInventoryItems: () => ({ data: { pages: [{ rows: h.candidates }] } }),
  useItemsById: () => ({ data: h.itemsById }),
}));

vi.mock('../usePhotoImageSrc', () => ({
  usePhotoImageSrc: () => ({ src: h.src, loading: h.loading }),
}));

import { RegionEditorDialog } from './RegionEditorDialog';

const PHOTO: LocationPhoto = {
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
};

/** Synthetic, COMPLETE region fixture (tests are excluded from tsc). */
const region = (overrides: Partial<LocationRegionWithCount> = {}): LocationRegionWithCount => ({
  id: 'r1',
  photoId: PHOTO.id,
  name: 'Top shelf',
  shape: 'rect',
  geometry: serialiseGeometry({ shape: 'rect', x: 0.1, y: 0.1, w: 0.3, h: 0.3 }),
  color: null,
  position: 0,
  createdAt: 0,
  updatedAt: 0,
  itemCount: 0,
  ...overrides,
});

/** Synthetic, COMPLETE item fixture. */
const item = (overrides: Partial<Item> = {}): Item =>
  ({
    id: 'item-1',
    name: 'NE555 timer',
    serialNo: null,
    ...overrides,
  }) as Item;

function renderDialog() {
  return render(<RegionEditorDialog open onClose={vi.fn()} photo={PHOTO} locationName="Workshop" />);
}

const dialog = () => within(screen.getByRole('dialog', { name: 'Regions on this photo' }));
const rows = () => screen.getAllByTestId('region-row');
/** The list row's own select button — distinct from the same region's shape on the overlay. */
const selectRow = (index: number) => within(rows()[index]!).getByTestId('region-select');

beforeEach(() => {
  h.regions = [];
  h.regionItemIds = [];
  h.itemsById = new Map();
  h.candidates = [];
  h.src = 'blob:photo';
  h.loading = false;
  h.addRegion.mockReset();
  h.updateRegion.mockReset();
  h.removeRegion.mockReset();
  h.link.mockReset();
});
afterEach(cleanup);

describe('RegionEditorDialog — the canvas and its fallbacks', () => {
  it('renders the photo with a named region overlay once the image resolves', () => {
    h.regions = [region()];
    renderDialog();
    const img = screen.getByAltText('Photo of Workshop');
    expect(img).toHaveAttribute('src', 'blob:photo');
    // The shape is a named button on the overlay — reachable without a pointer.
    expect(screen.getByRole('button', { name: 'Rectangle region “Top shelf”' })).toBeInTheDocument();
  });

  it('shows a spinner rather than a broken image while the photo is being read', () => {
    h.src = null;
    h.loading = true;
    renderDialog();
    expect(screen.getByTestId('region-photo-placeholder')).toBeInTheDocument();
    expect(screen.queryByAltText('Photo of Workshop')).not.toBeInTheDocument();
  });

  it('explains a photo that never arrived from a peer, instead of a broken image', () => {
    h.src = null;
    h.loading = false;
    renderDialog();
    expect(screen.getByTestId('region-photo-placeholder')).toHaveTextContent(
      'The full-size photo isn’t available on this device.',
    );
  });
});

describe('RegionEditorDialog — the region list is the primary path', () => {
  it('invites a first region when the photo has none', () => {
    renderDialog();
    expect(screen.getByTestId('regions-empty')).toBeInTheDocument();
    expect(screen.queryByTestId('region-list')).not.toBeInTheDocument();
  });

  it('lists each region with its shape and a pluralised item count', () => {
    h.regions = [
      region({ id: 'r1', name: 'Top shelf', shape: 'rect', itemCount: 1 }),
      region({
        id: 'r2',
        name: 'Parts bin',
        shape: 'circle',
        geometry: serialiseGeometry({ shape: 'circle', cx: 0.5, cy: 0.5, r: 0.1 }),
        itemCount: 4,
      }),
    ];
    renderDialog();
    expect(rows()).toHaveLength(2);
    expect(within(rows()[0]!).getByText('Rectangle · 1 item')).toBeInTheDocument();
    expect(within(rows()[1]!).getByText('Circle · 4 items')).toBeInTheDocument();
  });

  it('reveals the name, colour and item controls only once a region is selected', () => {
    h.regions = [region()];
    renderDialog();
    expect(screen.queryByTestId('region-editor-panel')).not.toBeInTheDocument();
    fireEvent.click(selectRow(0));
    const panel = within(screen.getByTestId('region-editor-panel'));
    expect(panel.getByLabelText('Region name')).toHaveValue('Top shelf');
    expect(screen.getByRole('radiogroup', { name: 'Colour (optional)' })).toBeInTheDocument();
    expect(panel.getByTestId('region-add-item')).toBeInTheDocument();
  });

  it('announces the selection through the live region', () => {
    h.regions = [region()];
    renderDialog();
    fireEvent.click(selectRow(0));
    expect(screen.getByRole('status')).toHaveTextContent('Region “Top shelf” selected.');
  });
});

describe('RegionEditorDialog — creating a region', () => {
  it('places a default rectangle from the keyboard-reachable Add button', () => {
    renderDialog();
    fireEvent.click(dialog().getByRole('button', { name: 'Add region' }));
    expect(h.addRegion).toHaveBeenCalledTimes(1);
    const [input] = h.addRegion.mock.calls[0]!;
    expect(input).toMatchObject({ photoId: PHOTO.id, name: 'New region', shape: 'rect', position: 0 });
    expect(JSON.parse(input.geometry)).toEqual({ x: 0.35, y: 0.35, w: 0.3, h: 0.3 });
  });

  it('places the shape the armed tool describes, not always a rectangle', () => {
    renderDialog();
    fireEvent.click(screen.getByTestId('region-tool-circle'));
    fireEvent.click(dialog().getByRole('button', { name: 'Add region' }));
    const [input] = h.addRegion.mock.calls[0]!;
    expect(input.shape).toBe('circle');
    expect(JSON.parse(input.geometry)).toEqual({ cx: 0.5, cy: 0.5, r: 0.15 });
  });

  it('stacks a new region above the existing ones so it wins an overlapping hit', () => {
    h.regions = [region({ id: 'r1' }), region({ id: 'r2' })];
    renderDialog();
    fireEvent.click(dialog().getByRole('button', { name: 'Add region' }));
    expect(h.addRegion.mock.calls[0]![0].position).toBe(2);
  });

  it('selects and announces the region the repository actually created', () => {
    h.addRegion.mockImplementation(
      (_input: unknown, opts?: { onSuccess?: (r: { id: string; name: string }) => void }) => {
        h.regions = [region({ id: 'new-1', name: 'New region' })];
        opts?.onSuccess?.({ id: 'new-1', name: 'New region' });
      },
    );
    renderDialog();
    fireEvent.click(dialog().getByRole('button', { name: 'Add region' }));
    expect(screen.getByRole('status')).toHaveTextContent('Region “New region” created.');
  });

  it('clears the selection when a drawing tool is armed, so a drag cannot duplicate a region', () => {
    h.regions = [region()];
    renderDialog();
    fireEvent.click(selectRow(0));
    expect(screen.getByTestId('region-editor-panel')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('region-tool-rect'));
    expect(screen.queryByTestId('region-editor-panel')).not.toBeInTheDocument();
  });
});

describe('RegionEditorDialog — editing a region', () => {
  it('saves a renamed region on blur, trimmed', () => {
    h.regions = [region()];
    renderDialog();
    fireEvent.click(selectRow(0));
    const field = screen.getByLabelText('Region name');
    fireEvent.change(field, { target: { value: '  Second shelf  ' } });
    expect(h.updateRegion).not.toHaveBeenCalled();
    fireEvent.blur(field);
    expect(h.updateRegion).toHaveBeenCalledWith({ id: 'r1', input: { name: 'Second shelf' } });
  });

  it('refuses to save a blank name', () => {
    h.regions = [region()];
    renderDialog();
    fireEvent.click(selectRow(0));
    const field = screen.getByLabelText('Region name');
    fireEvent.change(field, { target: { value: '   ' } });
    fireEvent.blur(field);
    expect(h.updateRegion).not.toHaveBeenCalled();
  });

  it('saves a colour chosen from the shared location palette', () => {
    h.regions = [region()];
    renderDialog();
    fireEvent.click(selectRow(0));
    fireEvent.click(screen.getByRole('radio', { name: 'Blue' }));
    expect(h.updateRegion).toHaveBeenCalledWith({ id: 'r1', input: { color: 'blue' } });
  });
});

describe('RegionEditorDialog — deleting a region', () => {
  it('asks first, making clear the items are only unplaced', () => {
    h.regions = [region()];
    renderDialog();
    fireEvent.click(screen.getByRole('button', { name: 'Delete region' }));
    expect(h.removeRegion).not.toHaveBeenCalled();
    expect(
      screen.getByText('Delete “Top shelf”? The items placed in it are kept — they are only unplaced.'),
    ).toBeInTheDocument();
  });

  it('deletes and announces once the confirm is taken', () => {
    h.regions = [region()];
    renderDialog();
    fireEvent.click(screen.getByRole('button', { name: 'Delete region' }));
    // Two "Delete region" controls now exist — the row's icon button and the confirm.
    h.removeRegion.mockImplementation((_id: string, opts?: { onSuccess?: () => void }) =>
      opts?.onSuccess?.(),
    );
    fireEvent.click(screen.getAllByRole('button', { name: 'Delete region' })[1]!);
    expect(h.removeRegion).toHaveBeenCalledWith('r1', expect.anything());
    expect(screen.getByRole('status')).toHaveTextContent('Region “Top shelf” deleted.');
  });

  it('backs out of the confirm without deleting', () => {
    h.regions = [region()];
    renderDialog();
    fireEvent.click(screen.getByRole('button', { name: 'Delete region' }));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(h.removeRegion).not.toHaveBeenCalled();
    expect(screen.queryByText(/only unplaced/)).not.toBeInTheDocument();
  });
});

describe('RegionEditorDialog — item placements', () => {
  beforeEach(() => {
    h.regions = [region()];
    h.candidates = [item({ id: 'i1', name: 'NE555 timer' }), item({ id: 'i2', name: 'Drill', serialNo: 7 })];
  });

  it('says so when nothing is placed in the region yet', () => {
    renderDialog();
    fireEvent.click(selectRow(0));
    expect(screen.getByTestId('region-items-empty')).toBeInTheDocument();
  });

  it('lists the placed items, each with its own remove control', () => {
    h.regionItemIds = ['i1', 'i2'];
    h.itemsById = new Map(h.candidates.map((i) => [i.id, i]));
    renderDialog();
    fireEvent.click(selectRow(0));
    expect(screen.getAllByTestId('region-item-row')).toHaveLength(2);
    // A serialised item reads with its number, exactly as it does elsewhere.
    expect(screen.getByRole('button', { name: 'Remove Drill #7 from this region' })).toBeInTheDocument();
  });

  it('places the item picked in the combobox', () => {
    renderDialog();
    fireEvent.click(selectRow(0));
    fireEvent.change(screen.getByTestId('region-add-item'), { target: { value: 'Drill #7' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    expect(h.link).toHaveBeenCalledWith({ itemId: 'i2', regionId: 'r1', linked: true }, expect.anything());
  });

  it('ignores typed text that matches no item, rather than inventing a link', () => {
    renderDialog();
    fireEvent.click(selectRow(0));
    fireEvent.change(screen.getByTestId('region-add-item'), { target: { value: 'Nothing like this' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    expect(h.link).not.toHaveBeenCalled();
  });

  it('unplaces an item without deleting it', () => {
    h.regionItemIds = ['i1'];
    h.itemsById = new Map([['i1', h.candidates[0]!]]);
    renderDialog();
    fireEvent.click(selectRow(0));
    fireEvent.click(screen.getByRole('button', { name: 'Remove NE555 timer from this region' }));
    expect(h.link).toHaveBeenCalledWith({ itemId: 'i1', regionId: 'r1', linked: false });
  });
});
