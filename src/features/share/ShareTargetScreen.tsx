import { useEffect, useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { PackageIcon } from '@/components/icons';
import {
  CreateItemDialog,
  type CreateItemInitialValues,
} from '@/features/inventory/components/CreateItemDialog';
import { useLocations } from '@/features/inventory/queries';
import { defaultLocationForNewItem, markedDefaultLocationId } from '@/features/inventory/location-tree';
import { LandingScaffold } from './LandingScaffold';
import { buildShareDraft } from './share-draft';
import { readShare, clearShare } from './share-inbox';

/**
 * Web Share Target landing screen (plan EI-4). Reached after the service worker
 * ({@link ../../sw}) captured a "Share to Gubbins" POST, stashed it, and redirected here with a
 * one-shot `share` id. It reads the stash back, maps it to add-item draft seed values with the
 * pure {@link ./share-draft} mapping, and opens the **reviewable** add-item dialog pre-filled — the
 * user always confirms, so a share is never auto-committed. Opened without a valid id (or after the
 * stash has been consumed) it simply presents an empty draft.
 */
export function ShareTargetScreen({ shareId }: { shareId?: string }) {
  const navigate = useNavigate();
  const flat = useLocations();
  const flatLocations = flat.data?.rows ?? [];

  const [seed, setSeed] = useState<{ initialValues: CreateItemInitialValues; image?: Blob } | null>(null);

  // Read (and consume) the stashed share exactly once. The inbox is one-shot: clear it as soon as
  // we've read it so a refresh of this URL can't replay a stale share into a second draft.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const stashed = shareId ? await readShare(shareId).catch(() => null) : null;
      if (shareId) void clearShare(shareId).catch(() => undefined);
      if (cancelled) return;
      const draft = buildShareDraft(stashed?.payload ?? {});
      setSeed({ initialValues: draft, image: stashed?.image ?? undefined });
    })();
    return () => {
      cancelled = true;
    };
  }, [shareId]);

  const close = () => void navigate({ to: '/inventory' });
  const ready = seed !== null && flat.data !== undefined;

  return (
    <LandingScaffold
      icon={<PackageIcon />}
      title="Add to Gubbins"
      message={
        ready ? 'Review the shared details and confirm to add the item.' : 'Preparing your shared item…'
      }
    >
      {ready ? (
        <CreateItemDialog
          open
          onClose={close}
          locations={flatLocations}
          defaultLocationId={defaultLocationForNewItem(
            null,
            flatLocations,
            markedDefaultLocationId(flatLocations),
          )}
          initialValues={seed.initialValues}
          initialImage={seed.image}
        />
      ) : null}
    </LandingScaffold>
  );
}
