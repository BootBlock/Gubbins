/**
 * `PlacementPickerDialog` — put *this* item into an existing region, from the item's side
 * (issue #392).
 *
 * ## It picks; it never draws
 *
 * Regions are authored in the location's own photo editor, and this dialog deliberately
 * cannot create, rename, retint, reshape or delete one: its canvas is `readOnly` and its
 * only verb is "place here". Two surfaces that both edit the same shapes would be two
 * places to look when one of them is wrong — so the item side stays a chooser, and the
 * copy points at the photo editor for everything else.
 *
 * ## Why ancestors are offered, not just the item's own location
 *
 * A region is usually drawn on a photo of the *containing* place — you photograph the
 * cabinet and mark out its drawers, not each drawer separately. Offering only the item's
 * own location would therefore hide the very photo its region lives on, so the candidate
 * set is the item's location plus every location above it, nearest first.
 */
import { useMemo, useState } from 'react';
import {
  Button,
  LiveRegion,
  Modal,
  RegionCanvas,
  SelectField,
  Spinner,
  type SelectOption,
} from '@/components/foundry';
import { ImageIcon } from '@/components/icons';
import type { LocationPhoto, LocationRegionWithCount } from '@/db/repositories';
import { useT } from '@/features/i18n';
import { cn } from '@/lib/utils';
import { useLocationPhotosFor, usePhotoRegions, type PlacementTarget } from '../location-media';
import { locationAncestry, locationPath } from '../location-tree';
import { useLocations } from '../queries';
import { usePhotoImageSrc } from '../usePhotoImageSrc';

export function PlacementPickerDialog({
  open,
  onClose,
  locationId,
  from,
  placedRegionIds,
  onChoose,
}: {
  open: boolean;
  onClose: () => void;
  /** The item's own location — the near end of the ancestry the picker offers photos from. */
  locationId: string;
  /** The placement being moved, or null when adding a new one. */
  from: PlacementTarget | null;
  /** Regions the item already sits in; offered but not choosable, so a no-op can't be committed. */
  placedRegionIds: ReadonlySet<string>;
  /** Hand the chosen region back to the panel, which owns the write and its error reporting. */
  onChoose: (target: PlacementTarget, regionName: string) => void;
}) {
  const t = useT();
  const { data: locationPage } = useLocations();
  const locations = useMemo(() => locationPage?.rows ?? [], [locationPage]);

  // The item's location first, then each ancestor — so the nearest, most specific photos lead.
  const candidateIds = useMemo(() => locationAncestry(locationId, locations), [locationId, locations]);
  const { data: photos, pending } = useLocationPhotosFor(candidateIds);

  const [photoId, setPhotoId] = useState<string | null>(null);
  const [regionId, setRegionId] = useState<string | null>(null);

  // Derived rather than synced through an effect: the fallback applies only while nothing
  // valid is chosen, so a background refetch that reorders the photo lists can never move
  // the user off the photo they are looking at. A move opens on the photo it started from —
  // beginning somewhere unrelated leaves the user to find their way back.
  const activePhotoId =
    photoId && photos.some((row) => row.id === photoId) ? photoId : (from?.photoId ?? photos[0]?.id ?? null);

  const photo = photos.find((row) => row.id === activePhotoId) ?? null;
  const { data: regions } = usePhotoRegions(photo?.id);
  const rows = useMemo(() => regions ?? [], [regions]);
  const { src, loading } = usePhotoImageSrc(photo ?? undefined);

  /**
   * A region the item already occupies is not a choice — committing it would be a write that
   * changes nothing while reading as though it did. The one exception is the region a *move*
   * started from: re-picking where you began is how you back out of a half-made move.
   *
   * This has to gate the **canvas** as well as the list. The list can simply disable a row,
   * but a shape on the photo has no disabled state, so both selection paths run through here
   * rather than the list alone — otherwise clicking the shape would quietly re-enable a
   * placement the list refuses.
   */
  const canChoose = (id: string) => !placedRegionIds.has(id) || id === from?.regionId;
  const select = (id: string | null) => {
    if (id === null || canChoose(id)) setRegionId(id);
  };

  const photoOptions: readonly SelectOption[] = useMemo(() => {
    const counts = new Map<string, number>();
    return photos.map((row) => {
      const n = (counts.get(row.locationId) ?? 0) + 1;
      counts.set(row.locationId, n);
      const location = locationPath(row.locationId, locations);
      return {
        value: row.id,
        label: row.caption
          ? t('inventory.placements.photoOption', { vars: { location, caption: row.caption } })
          : t('inventory.placements.photoOptionNumbered', { vars: { location, number: n } }),
      };
    });
  }, [photos, locations, t]);

  // Re-checked here, not just at selection time: the region list can change under an open
  // dialog, and a selection that has since become invalid must not stay committable.
  const chosen = rows.find((row) => row.id === regionId && canChoose(row.id)) ?? null;
  const title = from ? t('inventory.placements.moveTitle') : t('inventory.placements.addTitle');

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={title}
      description={t('inventory.placements.pickerDescription')}
      className="max-w-4xl"
    >
      <div className="space-y-4">
        {/* "Still loading" and "there are none" are different answers, so they are different
            nodes — sharing one would report an empty location while its photos are in flight. */}
        {pending ? (
          <Spinner />
        ) : photos.length === 0 ? (
          <p className="text-sm text-muted-foreground" data-testid="placement-picker-no-photos">
            {t('inventory.placements.noPhotos')}
          </p>
        ) : (
          <>
            <SelectField
              label={t('inventory.placements.photoLabel')}
              value={activePhotoId ?? ''}
              onChange={(next) => {
                setPhotoId(next);
                setRegionId(null);
              }}
              options={photoOptions}
              placeholder={t('inventory.placements.photoPlaceholder')}
              data-testid="placement-photo-select"
            />

            {/* Canvas beside the region list on a wide dialog; stacked on a narrow one — the
                same split the region editor uses, so the two surfaces read as one feature. */}
            <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_18rem]">
              <div className="min-w-0">
                <PhotoPreview
                  photo={photo}
                  locationName={photo ? locationPath(photo.locationId, locations) : ''}
                  src={src}
                  loading={loading}
                  regions={rows}
                  selectedId={regionId}
                  onSelect={select}
                />
              </div>
              <div className="min-w-0">
                <RegionChoices rows={rows} selectedId={regionId} canChoose={canChoose} onSelect={select} />
              </div>
            </div>
          </>
        )}

        {/* Choosing a region changes only a highlight, which is imperceptible without this. */}
        <LiveRegion visuallyHidden>
          {chosen ? <p>{t('inventory.regions.selected', { vars: { name: chosen.name } })}</p> : null}
        </LiveRegion>

        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            {t('inventory.placements.cancel')}
          </Button>
          <Button
            variant="primary"
            disabled={!chosen || !photo}
            onClick={() => {
              if (!chosen || !photo) return;
              onChoose({ photoId: photo.id, regionId: chosen.id }, chosen.name);
            }}
            data-testid="placement-confirm"
          >
            {from ? t('inventory.placements.confirmMove') : t('inventory.placements.confirm')}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

/** The photo with every region on it, read-only — clicking one selects it, nothing more. */
function PhotoPreview({
  photo,
  locationName,
  src,
  loading,
  regions,
  selectedId,
  onSelect,
}: {
  photo: LocationPhoto | null;
  locationName: string;
  src: string | null;
  loading: boolean;
  regions: readonly LocationRegionWithCount[];
  selectedId: string | null;
  onSelect: (id: string | null) => void;
}) {
  const t = useT();

  if (!photo || !src) {
    return (
      <div
        className="grid aspect-video w-full place-items-center rounded-lg border border-dashed border-border text-sm text-muted-foreground [&_svg]:size-6"
        data-testid="placement-photo-placeholder"
      >
        {loading ? (
          <Spinner />
        ) : (
          <span className="flex flex-col items-center gap-2 px-4 text-center">
            <ImageIcon aria-hidden="true" />
            {t('inventory.locationPhotos.missing')}
          </span>
        )}
      </div>
    );
  }

  return (
    <RegionCanvas
      src={src}
      alt={t('inventory.locationPhotos.alt', { vars: { location: locationName } })}
      naturalWidth={photo.naturalWidth}
      naturalHeight={photo.naturalHeight}
      regions={regions}
      selectedId={selectedId}
      // `null` (a click on blank photo) clears the choice — otherwise backing out of a
      // selection would be impossible from the canvas the selection was made on.
      onSelect={onSelect}
      overlayLabel={t('inventory.regions.canvasLabel')}
      regionLabel={(region) => region.name}
      className="aspect-video w-full rounded-lg border border-border bg-secondary/30"
    />
  );
}

/**
 * The keyboard-complete list of regions — the primary path, exactly as in the region editor.
 * A region the item is already in is shown but disabled: hiding it would read as "that region
 * is gone", where the truth is "you are already there".
 */
function RegionChoices({
  rows,
  selectedId,
  canChoose,
  onSelect,
}: {
  rows: readonly LocationRegionWithCount[];
  selectedId: string | null;
  /** Shared with the canvas, so both selection paths agree on what may be picked. */
  canChoose: (id: string) => boolean;
  onSelect: (id: string) => void;
}) {
  const t = useT();

  if (rows.length === 0) {
    return (
      <p className="text-xs text-muted-foreground" data-testid="placement-no-regions">
        {t('inventory.placements.noRegions')}
      </p>
    );
  }

  return (
    <ul className="flex flex-col gap-1" data-testid="placement-region-list">
      {rows.map((region) => {
        const already = !canChoose(region.id);
        return (
          <li key={region.id}>
            <button
              type="button"
              disabled={already}
              onClick={() => onSelect(region.id)}
              aria-pressed={region.id === selectedId}
              data-testid="placement-region-choice"
              className={cn(
                'w-full rounded-lg px-2.5 py-1.5 text-left outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:opacity-50',
                // The tint is never the only signal — `aria-pressed` carries the state for
                // assistive tech, and the canvas highlights the same shape.
                region.id === selectedId ? 'bg-primary/15' : 'bg-secondary/30',
              )}
            >
              <span className="block truncate text-sm font-medium">{region.name}</span>
              {already ? (
                <span className="block text-xs text-muted-foreground">
                  {t('inventory.placements.alreadyHere')}
                </span>
              ) : null}
            </button>
          </li>
        );
      })}
    </ul>
  );
}
