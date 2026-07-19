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
 *
 * ## Placing, moving and unplacing (issue #392)
 *
 * The panel is also where an item is put on a photo, moved to another region, or taken off one —
 * previously only reachable by opening the *location's* region editor and hunting for the item,
 * which is the wrong way round when the item is what you have in front of you. What it still
 * cannot do is change the regions themselves: drawing, naming, tinting and deleting stay in the
 * photo editor, so the shapes have exactly one home. See {@link PlacementPickerDialog}.
 */
import { useMemo, useState } from 'react';
import {
  Button,
  LiveRegion,
  RegionCanvas,
  Spinner,
  useToast,
  type RegionCanvasRegion,
} from '@/components/foundry';
import { AddIcon, ImageIcon, MoveIcon, UnlinkIcon } from '@/components/icons';
import type { Item, ItemRegionPlacement } from '@/db/repositories';
import { useErrorMessage } from '@/features/errors';
import { useT } from '@/features/i18n';
import {
  useItemPlacements,
  useLocationPhotos,
  useSetItemPlacement,
  type PlacementTarget,
} from '../location-media';
import { usePhotoImageSrc } from '../usePhotoImageSrc';
import { PlacementPickerDialog } from './PlacementPickerDialog';

export function ItemPlacementsPanel({ item }: { item: Item }) {
  const t = useT();
  const describeError = useErrorMessage();
  const { show } = useToast();
  const { data: placements } = useItemPlacements(item.id);
  const setPlacement = useSetItemPlacement();

  const rows = useMemo(() => placements ?? [], [placements]);
  const placedRegionIds = useMemo(() => new Set(rows.map((row) => row.regionId)), [rows]);

  // `null` = closed; otherwise `from` is the placement being moved, or null when adding.
  const [picking, setPicking] = useState<{ from: PlacementTarget | null } | null>(null);
  const [announcement, setAnnouncement] = useState<string | null>(null);

  // Any of these writes can fail — most plausibly against the §7.6 storage Hard Stop. Without a
  // toast the grid would simply not change, which is indistinguishable from a click that missed.
  const onError = (error: unknown) =>
    show({ tone: 'danger', message: describeError(error, t('inventory.placements.saveFailed')) });

  const unplace = (placement: ItemRegionPlacement) =>
    setPlacement.mutate(
      { itemId: item.id, from: { photoId: placement.photoId, regionId: placement.regionId } },
      {
        onError,
        onSuccess: () =>
          setAnnouncement(t('inventory.placements.removed', { vars: { region: placement.regionName } })),
      },
    );

  const commitChoice = (to: PlacementTarget, regionName: string) => {
    const from = picking?.from ?? null;
    setPlacement.mutate(
      { itemId: item.id, from, to },
      {
        onError,
        onSuccess: () => {
          setPicking(null);
          setAnnouncement(
            t(from ? 'inventory.placements.moved' : 'inventory.placements.placed', {
              vars: { region: regionName },
            }),
          );
        },
      },
    );
  };

  return (
    <div className="space-y-3">
      {rows.length === 0 ? (
        <p className="text-xs text-muted-foreground" data-testid="item-placements-empty">
          {t('inventory.placements.empty')}
        </p>
      ) : (
        <ul className="grid gap-3 sm:grid-cols-2" data-testid="item-placements-list">
          {rows.map((placement) => (
            <li key={placement.regionId}>
              <PlacementCard
                placement={placement}
                busy={setPlacement.isPending}
                onMove={() =>
                  setPicking({
                    from: { photoId: placement.photoId, regionId: placement.regionId },
                  })
                }
                onRemove={() => unplace(placement)}
              />
            </li>
          ))}
        </ul>
      )}

      <Button
        variant="outline"
        size="sm"
        onClick={() => setPicking({ from: null })}
        data-testid="item-placement-add"
      >
        <AddIcon aria-hidden="true" />
        {t('inventory.placements.add')}
      </Button>

      {/* Placing and unplacing change only a grid of pictures — the live region is what makes
          them perceivable without sight. Always mounted; only its text changes. */}
      <LiveRegion visuallyHidden>{announcement ? <p>{announcement}</p> : null}</LiveRegion>

      {/* Mounted only while open, so each visit starts from the item's current placement rather
          than wherever the previous one was left. */}
      {picking ? (
        <PlacementPickerDialog
          open
          onClose={() => setPicking(null)}
          locationId={item.locationId}
          from={picking.from}
          placedRegionIds={placedRegionIds}
          onChoose={commitChoice}
        />
      ) : null}
    </div>
  );
}

function PlacementCard({
  placement,
  busy,
  onMove,
  onRemove,
}: {
  placement: ItemRegionPlacement;
  busy: boolean;
  onMove: () => void;
  onRemove: () => void;
}) {
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
      <div className="flex items-center gap-1 px-2.5 py-2">
        <p className="min-w-0 flex-1 truncate text-sm">
          {t('inventory.placements.at', {
            vars: { region: placement.regionName, location: placement.locationName },
          })}
        </p>
        {/* Icon-only, so the card stays a picture rather than a button bar — and each names the
            region it acts on, since "Move" alone is ambiguous in a grid of several. */}
        <Button
          variant="ghost"
          size="sm"
          disabled={busy}
          aria-label={t('inventory.placements.move', { vars: { region: placement.regionName } })}
          onClick={onMove}
          className="[&_svg]:size-3.5"
          data-testid="item-placement-move"
        >
          <MoveIcon aria-hidden="true" />
        </Button>
        <Button
          variant="ghost"
          size="sm"
          disabled={busy}
          aria-label={t('inventory.placements.remove', { vars: { region: placement.regionName } })}
          onClick={onRemove}
          className="text-destructive [&_svg]:size-3.5"
          data-testid="item-placement-remove"
        >
          <UnlinkIcon aria-hidden="true" />
        </Button>
      </div>
    </div>
  );
}
