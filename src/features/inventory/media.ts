/**
 * Tier-1 hooks for item images and datasheet attachments (spec §2.1, §4, §4.2).
 *
 * The image add-hook orchestrates the full §4.2.3 pipeline on the main thread:
 * compress → write the raw WebP to OPFS → store only the path + thumbnail via the
 * worker. If the database write fails after the OPFS file lands, the orphaned file
 * is cleaned up. Removal deletes the DB record, then the raw OPFS file it pointed at.
 *
 * The OPFS write goes through `full-res-policy`, which refuses it once storage is
 * critically full (§7.6.1) and stores the image thumbnail-only instead.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  getAttachmentRepository,
  getImageRepository,
  type CreateAttachmentInput,
  type UpdateAttachmentInput,
} from '@/db/repositories';
import { useReportWriteFailure } from '@/features/errors';
import { processImageFile } from '@/features/images/compression';
import { placeFullResImage } from '@/features/images/full-res-policy';
import { deleteImageFile } from '@/features/images/opfs-images';
import { useStorageStore } from '@/state/stores/useStorageStore';
import { inventoryKeys } from './queries';
import { invalidateItems } from './invalidate';

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
  const reportFailure = useReportWriteFailure('inventory.writeError.heading.imageAdd', 'common.writeFailed');
  return useMutation({
    mutationFn: async ({ itemId, file }: { itemId: string; file: Blob }) => {
      const { fullRes, thumbnailBytes } = await processImageFile(file);
      // Read the tier at submit time, not at render: a poll may have moved it since.
      const { fullResOpfsPath, fullResDowngradedAt } = await placeFullResImage(
        fullRes,
        useStorageStore.getState().tier,
      );
      try {
        return await getImageRepository().add({
          itemId,
          thumbnailBlob: thumbnailBytes,
          fullResOpfsPath,
          fullResDowngradedAt,
        });
      } catch (err) {
        // The DB write failed — don't leak the raw OPFS file we just wrote.
        await deleteImageFile(fullResOpfsPath);
        throw err;
      }
    },
    // The pick is fire-and-forget (`ImageManager` just calls `.mutate`), so a failed store —
    // the storage hard stop, a constraint, `SQLITE_BUSY` — would otherwise vanish: the tile
    // simply never appears. Report it so the reason is shown and the retry is informed (#389).
    onError: reportFailure,
    onSettled: (_d, _e, { itemId }) => {
      void client.invalidateQueries({ queryKey: inventoryKeys.itemImages(itemId) });
      // The list/detail thumbnail JOIN means the item caches may change too.
      invalidateItems(client);
    },
  });
}

export function useRemoveItemImage() {
  const client = useQueryClient();
  const reportFailure = useReportWriteFailure(
    'inventory.writeError.heading.imageRemove',
    'common.writeFailed',
  );
  return useMutation({
    mutationFn: async ({ id }: { id: string; itemId: string }) => {
      const opfsPath = await getImageRepository().remove(id);
      if (opfsPath) await deleteImageFile(opfsPath);
    },
    // Removal is fired straight from the ✕ button with no error surface, so a failed delete
    // would leave the thumbnail sitting there with no explanation (#389).
    onError: reportFailure,
    onSettled: (_d, _e, { itemId }) => {
      void client.invalidateQueries({ queryKey: inventoryKeys.itemImages(itemId) });
      invalidateItems(client);
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
    onSettled: (_d, _e, input) => {
      void client.invalidateQueries({ queryKey: inventoryKeys.itemAttachments(input.itemId) });
      // Gaining a first datasheet must un-hide the section for a category that hides it
      // (issue #618); the presence probe is a deeper key than the one swept above.
      void client.invalidateQueries({ queryKey: inventoryKeys.itemSectionPresence(input.itemId) });
    },
  });
}

export function useUpdateAttachment(itemId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ id, input }: { id: string; input: UpdateAttachmentInput }) =>
      getAttachmentRepository().update(id, input),
    onSettled: () => {
      void client.invalidateQueries({ queryKey: inventoryKeys.itemAttachments(itemId) });
      void client.invalidateQueries({ queryKey: inventoryKeys.itemSectionPresence(itemId) });
    },
  });
}

export function useRemoveAttachment(itemId: string) {
  const client = useQueryClient();
  const reportFailure = useReportWriteFailure(
    'inventory.writeError.heading.attachmentRemove',
    'common.writeFailed',
  );
  return useMutation({
    mutationFn: (id: string) => getAttachmentRepository().remove(id),
    // Its siblings (`useAddAttachment`/`useUpdateAttachment`) surface errors at their call sites,
    // but removal is fired without one — so a failed delete would be silent here (#389).
    onError: reportFailure,
    onSettled: () => {
      void client.invalidateQueries({ queryKey: inventoryKeys.itemAttachments(itemId) });
      void client.invalidateQueries({ queryKey: inventoryKeys.itemSectionPresence(itemId) });
    },
  });
}
