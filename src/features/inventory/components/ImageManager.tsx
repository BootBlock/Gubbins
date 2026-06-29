import { InfoHint, Spinner } from '@/components/foundry';
import { CloseIcon, UploadIcon } from '@/components/icons';
import { useAddItemImage, useItemImages, useRemoveItemImage } from '../media';
import { Thumbnail } from './Thumbnail';

/**
 * Item image manager (spec §4.2). Picking a file runs the full §4.2.3 pipeline —
 * canvas→WebP compression, a raw OPFS file for the full image, and only a tiny
 * thumbnail + path stored in the database (never Base64, §4.2.1). The grid renders
 * the stored thumbnails; the full image is only ever read from OPFS on demand.
 */
export function ImageManager({ itemId }: { itemId: string }) {
  const { data: images, isLoading } = useItemImages(itemId);
  const addImage = useAddItemImage();
  const removeImage = useRemoveItemImage();

  const onPick = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (file) addImage.mutate({ itemId, file });
  };

  return (
    <div className="space-y-2">
    <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
      <span>Click the dashed tile to add a photo.</span>
      <InfoHint
        content={
          'Add one or more photos of the item. Each is **compressed to WebP** in the browser; ' +
          'the full-resolution image is stored as a file, and only a small **thumbnail** lives in ' +
          'the database — so syncing and backups stay lean.\n\nHover a thumbnail and click the ' +
          '✕ to remove it.'
        }
      />
    </div>
    <div className="grid grid-cols-3 gap-2 sm:grid-cols-4">
      {(images ?? []).map((img) => (
        <div key={img.id} className="group relative aspect-square overflow-hidden rounded-lg border border-border bg-secondary/30">
          <Thumbnail bytes={img.thumbnailBlob} alt="Item image" className="size-full" />
          <button
            type="button"
            aria-label="Remove image"
            onClick={() => removeImage.mutate({ id: img.id, itemId })}
            className="absolute right-1 top-1 grid size-6 origin-top-right scale-90 place-items-center rounded-full bg-background/80 text-destructive opacity-0 backdrop-blur transition-all duration-200 ease-emphasized group-hover:scale-100 group-hover:opacity-100 group-focus-within:scale-100 group-focus-within:opacity-100 [&_svg]:size-3.5"
          >
            <CloseIcon />
          </button>
        </div>
      ))}

      <label className="grid aspect-square cursor-pointer place-items-center rounded-lg border border-dashed border-border text-muted-foreground transition-colors hover:border-primary hover:text-primary [&_svg]:size-5">
        {addImage.isPending || isLoading ? <Spinner /> : <UploadIcon />}
        <input type="file" accept="image/*" className="sr-only" onChange={onPick} aria-label="Upload image" />
      </label>
    </div>
    </div>
  );
}
