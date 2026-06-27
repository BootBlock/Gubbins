import { useState } from 'react';
import { LinkIcon } from '@/components/icons';
import type { Item } from '@/db/repositories';
import { formatCurrency } from '@/lib/format';
import {
  ScrapeReviewDialog,
  ScrapeSupplierPanel,
  useScrapeNotifier,
  type ScrapeResultPayload,
  type ScrapeWrite,
} from '@/features/scraping';
import { usePreferencesStore } from '@/state/stores/usePreferencesStore';
import { useItemAliases } from '../queries';
import { useApplyScrape } from '../mutations';

/**
 * Supplier-data facet of the item detail dialog (spec §4, §9): shows the MPN,
 * manufacturer, unit cost and the Universal Alias Mapping, and — when the companion
 * extension is present — offers a re-scrape that applies through the §4 no-overwrite
 * review. Existing values are never changed without the user's explicit opt-in.
 */
export function SupplierDataEditor({ item }: { item: Item }) {
  const { data: aliases } = useItemAliases(item.id);
  const applyScrape = useApplyScrape();
  const notify = useScrapeNotifier();
  const baseCurrency = usePreferencesStore((s) => s.baseCurrency);
  const [reviewPayload, setReviewPayload] = useState<ScrapeResultPayload | null>(null);

  const existing = {
    mpn: item.mpn,
    manufacturer: item.manufacturer,
    description: item.description,
    unitCost: item.unitCost,
    aliases: (aliases ?? []).map((a) => a.alias),
  };

  const onApply = (write: ScrapeWrite) => {
    const changed = [
      ...Object.keys(write.fields),
      ...write.aliasAdditions.map((a) => `alias ${a}`),
    ];
    applyScrape.mutate(
      { id: item.id, write },
      {
        onSuccess: () => {
          notify(changed.length > 0 ? `Updated ${changed.join(', ')}.` : 'No changes applied.');
          setReviewPayload(null);
        },
      },
    );
  };

  return (
    <div className="space-y-3">
      <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
        <Detail label="MPN" value={item.mpn} />
        <Detail label="Manufacturer" value={item.manufacturer} />
        <Detail
          label="Unit cost"
          value={item.unitCost !== null ? formatCurrency(item.unitCost, baseCurrency) : null}
        />
      </dl>

      <div>
        <p className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          Supplier aliases
        </p>
        {aliases && aliases.length > 0 ? (
          <div className="flex flex-wrap gap-1.5">
            {aliases.map((a) => (
              <span
                key={a.id}
                className="inline-flex items-center gap-1 rounded-full bg-primary/10 px-2.5 py-1 text-xs font-medium text-primary [&_svg]:size-3"
              >
                <LinkIcon />
                {a.alias}
              </span>
            ))}
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">No supplier part numbers mapped yet.</p>
        )}
      </div>

      <ScrapeSupplierPanel onResult={setReviewPayload} />

      {reviewPayload ? (
        <ScrapeReviewDialog
          open
          existing={existing}
          payload={reviewPayload}
          onApply={onApply}
          onClose={() => setReviewPayload(null)}
          isApplying={applyScrape.isPending}
        />
      ) : null}
    </div>
  );
}

function Detail({ label, value }: { label: string; value: string | null }) {
  return (
    <div>
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="font-medium">{value ?? '—'}</dd>
    </div>
  );
}
