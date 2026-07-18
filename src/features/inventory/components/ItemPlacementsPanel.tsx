/**
 * `ItemPlacementsPanel` — the item side of location regions (issue #81): "where, exactly, does
 * this live?", answered with a picture rather than prose.
 *
 * Every placement renders the location's photo with just *that* region highlighted, through the
 * same {@link RegionCanvas} the editor uses — at its **default** `readOnly`, so a viewer can never
 * accidentally become a drawing surface.
 *
 * `ItemRegionPlacement` carries the region's geometry and the location's name, but not the photo's
 * dimensions or bytes (it is a join projection, not a photo read), so each card resolves its photo
 * from the location's photo list. That keeps the panel on the existing hooks rather than adding a
 * repository read for one screen.
 */
import { useMemo } from 'react';
import { RegionCanvas, Spinner, type RegionCanvasRegion } from '@/components/foundry';
import { ImageIcon } from '@/components/icons';
import type { ItemRegionPlacement } from '@/db/repositories';
import { useT } from '@/features/i18n';
import { useItemPlacements, useLocationPhotos } from '../location-media';
import { usePhotoImageSrc } from '../usePhotoImageSrc';

export function ItemPlacementsPanel({ itemId }: { itemId: string }) {
  const t = useT();
  const { data: placements } = useItemPlacements(itemId);
  const rows = placements ?? [];

  if (rows.length === 0) {
    return (
      <p className="text-xs text-muted-foreground" data-testid="item-placements-empty">
        {t('inventory.placements.empty')}
      </p>
    );
  }

  return (
    <ul className="grid gap-3 sm:grid-cols-2" data-testid="item-placements-list">
      {rows.map((placement) => (
        <li key={placement.regionId}>
          <PlacementCard placement={placement} />
        </li>
      ))}
    </ul>
  );
}

function PlacementCard({ placement }: { placement: ItemRegionPlacement }) {
  const t = useT();
  const { data: photos } = useLocationPhotos(placement.locationId);
  const photo = photos?.find((row) => row.id === placement.photoId);
  const { src, loading } = usePhotoImageSrc(photo);

  // The one region this card is about, shaped for the canvas and marked selected so it reads as
  // the highlighted answer rather than one shape among many.
  const regions: readonly RegionCanvasRegion[] = useMemo(
    () => [
      {
        id: placement.regionId,
        name: placement.regionName,
        shape: placement.shape,
        geometry: placement.geometry,
        color: placement.color,
        position: 0,
      },
    ],
    [placement],
  );

  const alt = t('inventory.locationPhotos.alt', { vars: { location: placement.locationName } });

  return (
    <div
      className="overflow-hidden rounded-lg border border-border bg-secondary/20"
      data-testid="item-placement-card"
    >
      {src && photo ? (
        <RegionCanvas
          src={src}
          alt={alt}
          naturalWidth={photo.naturalWidth}
          naturalHeight={photo.naturalHeight}
          regions={regions}
          selectedId={placement.regionId}
          overlayLabel={t('inventory.regions.canvasLabel')}
          regionLabel={(region) => region.name}
          className="aspect-video w-full bg-secondary/30"
        />
      ) : (
        <div
          className="grid aspect-video w-full place-items-center text-xs text-muted-foreground [&_svg]:size-5"
          data-testid="item-placement-placeholder"
        >
          {loading ? (
            <Spinner />
          ) : (
            <span className="flex flex-col items-center gap-1.5 px-3 text-center">
              <ImageIcon aria-hidden="true" />
              {t('inventory.locationPhotos.missing')}
            </span>
          )}
        </div>
      )}
      <p className="px-2.5 py-2 text-sm">
        {t('inventory.placements.at', {
          vars: { region: placement.regionName, location: placement.locationName },
        })}
      </p>
    </div>
  );
}
