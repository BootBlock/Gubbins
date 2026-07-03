import { useEffect, useMemo } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { LinkIcon } from '@/components/icons';
import { ItemDetailDialog } from '@/features/inventory/components/ItemDetailDialog';
import { CreateItemDialog } from '@/features/inventory/components/CreateItemDialog';
import { useItem, useLocations } from '@/features/inventory/queries';
import { defaultLocationForNewItem, markedDefaultLocationId } from '@/features/inventory/location-tree';
import { LandingScaffold } from './LandingScaffold';
import { buildShareDraft } from './share-draft';
import { parseDeepLink } from './deep-link';

/**
 * `web+gubbins:` protocol-handler landing screen (plan EI-4). The OS routes a `web+gubbins://…`
 * deep link to the installed PWA with the raw link in `?target=`; this screen parses it with the
 * pure {@link ./deep-link} seam and opens the matching **read/draft** surface — an item's detail
 * dialog for `item/<id>`, or a pre-filled add-item draft for `add?…`. An unrecognised or
 * unresolvable link falls back to the inventory screen. A deep link never mutates on its own.
 */
export function DeepLinkScreen({ target }: { target?: string }) {
  const navigate = useNavigate();
  const intent = useMemo(() => parseDeepLink(target ?? ''), [target]);

  const itemId = intent.kind === 'item' ? intent.id : undefined;
  const itemQuery = useItem(itemId);
  const flat = useLocations();
  const flatLocations = flat.data?.rows ?? [];

  const toInventory = () => void navigate({ to: '/inventory' });

  // Nothing we can open (unknown link, or a deep link to an item that doesn't exist here) → hand
  // the user to the inventory screen rather than leaving them on a dead landing page.
  const itemMissing = intent.kind === 'item' && itemQuery.isSuccess && !itemQuery.data;
  useEffect(() => {
    if (intent.kind === 'unknown' || itemMissing) toInventory();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [intent.kind, itemMissing]);

  const addSeed = intent.kind === 'add' ? buildShareDraft(intent.payload) : null;

  return (
    <LandingScaffold icon={<LinkIcon />} title="Open in Gubbins" message="Following your link…">
      {intent.kind === 'item' && itemQuery.data ? (
        <ItemDetailDialog item={itemQuery.data} open onClose={toInventory} />
      ) : null}

      {addSeed && flat.data ? (
        <CreateItemDialog
          open
          onClose={toInventory}
          locations={flatLocations}
          defaultLocationId={defaultLocationForNewItem(
            null,
            flatLocations,
            markedDefaultLocationId(flatLocations),
          )}
          initialValues={addSeed}
        />
      ) : null}
    </LandingScaffold>
  );
}
