/**
 * Tier-1 hooks for item images and datasheet attachments (spec §2.1, §4, §4.2).
 *
 * The image add-hook orchestrates the full §4.2.3 pipeline on the main thread:
 * compress → write the raw WebP to OPFS → store only the path + thumbnail via the
 * worker. If the database write fails after the OPFS file lands, the orphaned file
 * is cleaned up. Removal deletes the DB record, then the raw OPFS file it pointed at.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  getAttachmentRepository,
  getImageRepository,
  type CreateAttachmentInput,
  type UpdateAttachmentInput,
} from '@/db/repositories';
import { processImageFile } from '@/features/images/compression';
import { deleteImageFile, saveImageFile } from '@/features/images/opfs-images';
import { inventoryKeys } from './queries';

// --- Images ---------------------------------------------------------------------

export function useItemImages(itemId: string | undefined) {
  return useQuery({
    queryKey: inventoryKeys.itemImages(itemId ?? ''),
    queryFn: () => getImageRepository().listForItem(itemId!),
    enabled: Boolean(itemId),
  });
}

/** Compress a picked file, store the raw WebP in OPFS, and record its metadata. */
export function useAddItemImage() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async ({ itemId, file }: { itemId: string; file: Blob }) => {
      const { fullRes, thumbnailBytes } = await processImageFile(file);
      const fullResOpfsPath = await saveImageFile(fullRes);
      try {
        return await getImageRepository().add({
          itemId,
          thumbnailBlob: thumbnailBytes,
          fullResOpfsPath,
        });
      } catch (err) {
        // The DB write failed — don't leak the raw OPFS file we just wrote.
        await deleteImageFile(fullResOpfsPath);
        throw err;
      }
    },
    onSettled: (_d, _e, { itemId }) => {
      void client.invalidateQueries({ queryKey: inventoryKeys.itemImages(itemId) });
      // The list/detail thumbnail JOIN means the item caches may change too.
      void client.invalidateQueries({ queryKey: inventoryKeys.items() });
    },
  });
}

export function useRemoveItemImage() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async ({ id }: { id: string; itemId: string }) => {
      const opfsPath = await getImageRepository().remove(id);
      if (opfsPath) await deleteImageFile(opfsPath);
    },
    onSettled: (_d, _e, { itemId }) => {
      void client.invalidateQueries({ queryKey: inventoryKeys.itemImages(itemId) });
      void client.invalidateQueries({ queryKey: inventoryKeys.items() });
    },
  });
}

// --- Attachments / datasheets ---------------------------------------------------

export function useItemAttachments(itemId: string | undefined) {
  return useQuery({
    queryKey: inventoryKeys.itemAttachments(itemId ?? ''),
    queryFn: () => getAttachmentRepository().listForItem(itemId!),
    enabled: Boolean(itemId),
  });
}

export function useAddAttachment() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateAttachmentInput) => getAttachmentRepository().add(input),
    onSettled: (_d, _e, input) =>
      void client.invalidateQueries({ queryKey: inventoryKeys.itemAttachments(input.itemId) }),
  });
}

export function useUpdateAttachment(itemId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ id, input }: { id: string; input: UpdateAttachmentInput }) =>
      getAttachmentRepository().update(id, input),
    onSettled: () =>
      void client.invalidateQueries({ queryKey: inventoryKeys.itemAttachments(itemId) }),
  });
}

export function useRemoveAttachment(itemId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => getAttachmentRepository().remove(id),
    onSettled: () =>
      void client.invalidateQueries({ queryKey: inventoryKeys.itemAttachments(itemId) }),
  });
}
