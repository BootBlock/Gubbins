/**
 * Tier-1 hooks for location photos and the regions drawn on them (issue #81).
 *
 * The add-hook runs the same §4.2.3 pipeline as item images — compress → write the raw WebP
 * to OPFS → store only the path + thumbnail via the worker — and cleans up the orphaned OPFS
 * file if the database write fails afterwards. Removal deletes the record first, then the raw
 * file it pointed at.
 *
 * The extra step over `media.ts` is that a photo records its **natural dimensions**: region
 * geometry is normalised, so the overlay needs the aspect ratio before the full-resolution
 * file decodes — and on a peer device that file may never arrive, since only the thumbnail
 * syncs.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  getLocationPhotoRepository,
  type CreateLocationRegionInput,
  type UpdateLocationRegionInput,
} from '@/db/repositories';
import { processImageFile } from '@/features/images/compression';
import { deleteImageFile, saveImageFile } from '@/features/images/opfs-images';
import { inventoryKeys } from './queries';

// --- Photos ---------------------------------------------------------------------

export function useLocationPhotos(locationId: string | undefined) {
  return useQuery({
    queryKey: inventoryKeys.locationPhotos(locationId ?? ''),
    queryFn: () => getLocationPhotoRepository().listForLocation(locationId!),
    enabled: Boolean(locationId),
  });
}

/**
 * Read a blob's pixel dimensions without touching the DOM's layout: `createImageBitmap`
 * decodes off the main render path and is already the decoder the compression pipeline uses.
 * Measured from the *compressed* full-res artefact, not the original upload, so the stored
 * dimensions describe the file the regions are actually drawn over.
 */
async function readDimensions(blob: Blob): Promise<{ width: number; height: number }> {
  const bitmap = await createImageBitmap(blob);
  try {
    return { width: bitmap.width, height: bitmap.height };
  } finally {
    bitmap.close();
  }
}

/** Compress a picked file, store the raw WebP in OPFS, and record its metadata. */
export function useAddLocationPhoto() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async ({
      locationId,
      file,
      caption,
    }: {
      locationId: string;
      file: Blob;
      caption?: string | null;
    }) => {
      const { fullRes, thumbnailBytes } = await processImageFile(file);
      const { width, height } = await readDimensions(fullRes);
      const fullResOpfsPath = await saveImageFile(fullRes);
      try {
        return await getLocationPhotoRepository().addPhoto({
          locationId,
          caption: caption ?? null,
          thumbnailBlob: thumbnailBytes,
          fullResOpfsPath,
          naturalWidth: width,
          naturalHeight: height,
        });
      } catch (err) {
        // The DB write failed — don't leak the raw OPFS file we just wrote.
        await deleteImageFile(fullResOpfsPath);
        throw err;
      }
    },
    onSettled: (_d, _e, { locationId }) => {
      void client.invalidateQueries({ queryKey: inventoryKeys.locationPhotos(locationId) });
    },
  });
}

export function useRemoveLocationPhoto() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async ({ id }: { id: string; locationId: string }) => {
      const opfsPath = await getLocationPhotoRepository().removePhoto(id);
      if (opfsPath) await deleteImageFile(opfsPath);
    },
    onSettled: (_d, _e, { locationId }) => {
      void client.invalidateQueries({ queryKey: inventoryKeys.locationPhotos(locationId) });
    },
  });
}

export function useUpdatePhotoCaption() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ id, caption }: { id: string; caption: string | null; locationId: string }) =>
      getLocationPhotoRepository().updatePhotoCaption(id, caption),
    onSettled: (_d, _e, { locationId }) => {
      void client.invalidateQueries({ queryKey: inventoryKeys.locationPhotos(locationId) });
    },
  });
}

// --- Regions --------------------------------------------------------------------

export function usePhotoRegions(photoId: string | undefined) {
  return useQuery({
    queryKey: inventoryKeys.photoRegions(photoId ?? ''),
    queryFn: () => getLocationPhotoRepository().listRegions(photoId!),
    enabled: Boolean(photoId),
  });
}

export function useAddRegion() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateLocationRegionInput) => getLocationPhotoRepository().addRegion(input),
    onSettled: (_d, _e, input) => {
      void client.invalidateQueries({ queryKey: inventoryKeys.photoRegions(input.photoId) });
    },
  });
}

export function useUpdateRegion(photoId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ id, input }: { id: string; input: UpdateLocationRegionInput }) =>
      getLocationPhotoRepository().updateRegion(id, input),
    onSettled: () => {
      void client.invalidateQueries({ queryKey: inventoryKeys.photoRegions(photoId) });
    },
  });
}

export function useRemoveRegion(photoId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => getLocationPhotoRepository().removeRegion(id),
    onSettled: () => {
      void client.invalidateQueries({ queryKey: inventoryKeys.photoRegions(photoId) });
    },
  });
}

// --- Item placements ------------------------------------------------------------

/** Every region an item is placed in, resolved up to its location. */
export function useItemPlacements(itemId: string | undefined) {
  return useQuery({
    queryKey: inventoryKeys.itemPlacements(itemId ?? ''),
    queryFn: () => getLocationPhotoRepository().listPlacementsForItem(itemId!),
    enabled: Boolean(itemId),
  });
}

export function useRegionItemIds(regionId: string | undefined) {
  return useQuery({
    queryKey: [...inventoryKeys.photoRegions(''), 'items', regionId ?? ''] as const,
    queryFn: () => getLocationPhotoRepository().listRegionItemIds(regionId!),
    enabled: Boolean(regionId),
  });
}

/**
 * Place an item in a region, or remove it. Both invalidate the item's placement list *and*
 * the photo's region list, because the region rows carry an item count that the link changes.
 */
export function useLinkItemToRegion(photoId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ itemId, regionId, linked }: { itemId: string; regionId: string; linked: boolean }) =>
      linked
        ? getLocationPhotoRepository().linkItem(itemId, regionId)
        : getLocationPhotoRepository().unlinkItem(itemId, regionId),
    onSettled: (_d, _e, { itemId, regionId }) => {
      void client.invalidateQueries({ queryKey: inventoryKeys.itemPlacements(itemId) });
      void client.invalidateQueries({ queryKey: inventoryKeys.photoRegions(photoId) });
      void client.invalidateQueries({
        queryKey: [...inventoryKeys.photoRegions(''), 'items', regionId] as const,
      });
    },
  });
}
