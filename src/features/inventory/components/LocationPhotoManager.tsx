/**
 * `LocationPhotoManager` — the photo grid for one location (issue #81).
 *
 * Deliberately a **separate component from {@link ImageManager}**, not a generalisation of it.
 * The two grids look alike but carry different payloads: a location photo owns a caption, a
 * region count and a way into the region editor, none of which an item image has. Threading an
 * owner discriminator through `ImageManager` would make both call sites read as the union of
 * their differences, and would drag `ImageManager`'s characterised behaviour into the blast
 * radius of every change made here. `ImageManager`'s *visual language* is reused (the square
 * thumbnail tiles, the hover-revealed remove control, the dashed add tile); its code is not.
 *
 * Each tile owns its own region count, so `usePhotoRegions` is called per tile rather than the
 * grid trying to fetch a photo→count map that no repository read offers.
 */
import { useState } from 'react';
import { Button, FormField, InfoHint, Input, Spinner, useToast } from '@/components/foundry';
import { CloseIcon, MapViewIcon, UploadIcon } from '@/components/icons';
import type { LocationPhoto } from '@/db/repositories';
import { useT } from '@/features/i18n';
import { FullResDisabledNote } from '@/features/images/FullResDisabledNote';
import {
  useAddLocationPhoto,
  useLocationPhotos,
  usePhotoRegions,
  useRemoveLocationPhoto,
  useUpdatePhotoCaption,
} from '../location-media';
import { RegionEditorDialog } from './RegionEditorDialog';
import { Thumbnail } from './Thumbnail';
import { useErrorMessage } from '@/features/errors';

export function LocationPhotoManager({
  locationId,
  locationName,
}: {
  locationId: string;
  /** Used for the photos' alternative text — "Photo of {location}". */
  locationName: string;
}) {
  const t = useT();
  const describeError = useErrorMessage();
  const { show } = useToast();
  const { data: photos, isLoading } = useLocationPhotos(locationId);
  const addPhoto = useAddLocationPhoto();
  // A write can fail — most plausibly against the §7.6 storage Hard Stop, which photos are the
  // likeliest thing to trip. Silence would be indistinguishable from the app ignoring the pick.
  const onFailure = (error: unknown) =>
    show({
      tone: 'danger',
      message: describeError(error, t('inventory.locationPhotos.saveFailed')),
    });
  // The *id* is held, not the row: the list re-fetches on every caption edit and region change,
  // so holding the row would pin a stale copy open behind the editor.
  const [editingId, setEditingId] = useState<string | null>(null);

  const rows = photos ?? [];
  const editing = rows.find((photo) => photo.id === editingId) ?? null;

  const onPick = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    // Cleared before the mutation so picking the same file twice still fires a change event.
    event.target.value = '';
    if (file) addPhoto.mutate({ locationId, file }, { onError: onFailure });
  };

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <span>{t('inventory.locationPhotos.addLabel')}</span>
        <InfoHint content={t('inventory.locationPhotos.hint')} />
      </div>

      <FullResDisabledNote />

      {rows.length === 0 && !isLoading ? (
        <p className="text-sm text-muted-foreground" data-testid="location-photos-empty">
          {t('inventory.locationPhotos.empty')}
        </p>
      ) : null}

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        {rows.map((photo) => (
          <PhotoTile
            // Keyed on the row id so a re-fetch never re-seeds another photo's caption draft.
            key={photo.id}
            photo={photo}
            locationName={locationName}
            onOpenEditor={() => setEditingId(photo.id)}
            onError={onFailure}
          />
        ))}

        <label className="grid aspect-square cursor-pointer place-items-center rounded-lg border border-dashed border-border text-muted-foreground transition-colors hover:border-primary hover:text-primary [&_svg]:size-5">
          {addPhoto.isPending || isLoading ? <Spinner /> : <UploadIcon aria-hidden="true" />}
          <input
            type="file"
            accept="image/*"
            className="sr-only"
            onChange={onPick}
            aria-label={t('inventory.locationPhotos.uploadLabel')}
          />
        </label>
      </div>

      {/* Nested dialog — mounted only while a photo is open, so its OPFS read and region
          queries never run for a location the user is merely looking at. */}
      {editing ? (
        <RegionEditorDialog
          open
          onClose={() => setEditingId(null)}
          photo={editing}
          locationName={locationName}
        />
      ) : null}
    </div>
  );
}

/** One photo: its thumbnail, caption, region count and the two actions it offers. */
function PhotoTile({
  photo,
  locationName,
  onOpenEditor,
  onError,
}: {
  photo: LocationPhoto;
  locationName: string;
  onOpenEditor: () => void;
  onError: (error: unknown) => void;
}) {
  const t = useT();
  const { data: regions } = usePhotoRegions(photo.id);
  const removePhoto = useRemoveLocationPhoto();
  const updateCaption = useUpdatePhotoCaption();
  const [caption, setCaption] = useState(photo.caption ?? '');
  // Deleting a photo takes its regions and every item placement on them with it, and the raw
  // file with them — strictly more destructive than deleting a single region, which already
  // confirms. A two-step confirm in place, matching the region list, so the copy explaining
  // what else goes appears exactly where the decision is made.
  const [confirming, setConfirming] = useState(false);

  const regionCount = regions?.length ?? 0;
  const stored = photo.caption ?? '';

  // Saved on blur rather than per keystroke: the caption is a whole thought, and a mutation per
  // character would invalidate the photo list under the field being typed into.
  const commitCaption = () => {
    const next = caption.trim();
    if (next === stored) return;
    updateCaption.mutate({ id: photo.id, caption: next || null, locationId: photo.locationId }, { onError });
  };

  return (
    <div
      className="group flex flex-col gap-field-gap-compact rounded-lg border border-border bg-secondary/30 p-2"
      data-testid="location-photo-tile"
    >
      <div className="relative aspect-square overflow-hidden rounded-md">
        <Thumbnail
          bytes={photo.thumbnailBlob}
          alt={t('inventory.locationPhotos.alt', { vars: { location: locationName } })}
          className="size-full"
        />
        <button
          type="button"
          aria-label={t('inventory.locationPhotos.removeLabel')}
          onClick={() => setConfirming(true)}
          className="absolute right-1 top-1 grid size-6 origin-top-right scale-90 place-items-center rounded-full bg-background/80 text-destructive opacity-0 backdrop-blur transition-all duration-200 ease-emphasized group-hover:scale-100 group-hover:opacity-100 group-focus-within:scale-100 group-focus-within:opacity-100 [&_svg]:size-3.5"
        >
          <CloseIcon aria-hidden="true" />
        </button>
      </div>

      {confirming ? (
        <div className="rounded-md bg-destructive/10 p-2" data-testid="photo-delete-confirm">
          <p className="text-xs text-destructive">{t('inventory.locationPhotos.removeConfirm')}</p>
          <div className="mt-field-gap-compact flex justify-end gap-2">
            <Button variant="ghost" size="sm" onClick={() => setConfirming(false)}>
              {t('inventory.locationPhotos.removeCancel')}
            </Button>
            <Button
              variant="destructive"
              size="sm"
              onClick={() =>
                removePhoto.mutate(
                  { id: photo.id, locationId: photo.locationId },
                  { onError, onSuccess: () => setConfirming(false) },
                )
              }
            >
              {t('inventory.locationPhotos.removeConfirmAction')}
            </Button>
          </div>
        </div>
      ) : null}

      <FormField label={<span className="text-xs">{t('inventory.locationPhotos.captionLabel')}</span>}>
        <Input
          value={caption}
          onChange={(event) => setCaption(event.target.value)}
          onBlur={commitCaption}
          placeholder={t('inventory.locationPhotos.captionPlaceholder')}
          className="h-8 text-xs"
        />
      </FormField>

      <div className="flex items-center justify-between gap-2">
        <span className="text-xs text-muted-foreground">
          {t('inventory.locationPhotos.regionCount', { vars: { count: regionCount } })}
        </span>
        <Button variant="ghost" size="sm" onClick={onOpenEditor} className="[&_svg]:size-3.5">
          <MapViewIcon aria-hidden="true" />
          {t('inventory.locationPhotos.openEditor')}
        </Button>
      </div>
    </div>
  );
}
