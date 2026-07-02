import { useState } from 'react';
import { InfoHint } from '@/components/foundry';
import { LinkIcon } from '@/components/icons';
import type { Item } from '@/db/repositories';
import {
  ScrapeReviewDialog,
  ScrapeSupplierPanel,
  buildSupplierPartPlan,
  resolveSupplierPartWrite,
  useScrapeNotifier,
  type ScrapeResultPayload,
  type ScrapeWrite,
} from '@/features/scraping';
import { useItemAliases, useItemSupplierParts } from '../queries';
import { useApplyScrape, useCreateSupplierPart, useUpdateSupplierPart } from '../mutations';
import { SupplierPartsTable } from './SupplierPartsTable';

/**
 * Supplier-data facet of the item detail dialog (spec §4, §9): the Universal Alias
 * Mapping and the editable **supplier-parts table** (N suppliers per item, Phase 60).
 * When the companion extension is present it offers a re-scrape that applies through the
 * §4 no-overwrite review — and, on apply, persists the fetched per-supplier pricing as a
 * supplier part without ever clobbering an existing supplier row (only create-or-fill,
 * never overwrite). The item's own MPN, manufacturer and manual unit cost are edited on
 * the **Details** tab ({@link ItemDetailsEditor}); a scrape can still fill them here via
 * the review, but they are not mirrored read-only in this section (they used to be, which
 * duplicated the now-editable Details fields).
 */
export function SupplierDataEditor({ item }: { item: Item }) {
  const { data: aliases } = useItemAliases(item.id);
  const { data: supplierParts } = useItemSupplierParts(item.id);
  const applyScrape = useApplyScrape();
  const createSupplierPart = useCreateSupplierPart();
  const updateSupplierPart = useUpdateSupplierPart();
  const notify = useScrapeNotifier();
  const [reviewPayload, setReviewPayload] = useState<ScrapeResultPayload | null>(null);

  const existing = {
    mpn: item.mpn,
    manufacturer: item.manufacturer,
    description: item.description,
    unitCost: item.unitCost,
    aliases: (aliases ?? []).map((a) => a.alias),
  };

  /**
   * Persist the scrape's per-supplier pricing as a supplier part, §4 no-overwrite-safe:
   * with no overwrite opt-in, {@link resolveSupplierPartWrite} only *creates* a new supplier
   * row or *fills empty* fields on a matching one — it never clobbers a user value. A
   * conflicting field is left for the user to edit in the table.
   */
  const persistSupplierPricing = (payload: ScrapeResultPayload): string | null => {
    const plan = buildSupplierPartPlan(payload, supplierParts ?? []);
    const write = resolveSupplierPartWrite(plan);
    if (write.kind === 'create') {
      createSupplierPart.mutate({ itemId: item.id, input: write.input });
      return `supplier ${plan.supplierName}`;
    }
    if (write.kind === 'update') {
      updateSupplierPart.mutate({ id: write.id, itemId: item.id, input: write.input });
      return `supplier ${plan.supplierName}`;
    }
    return null;
  };

  const onApply = (write: ScrapeWrite) => {
    const supplierChange = reviewPayload ? persistSupplierPricing(reviewPayload) : null;
    const changed = [
      ...Object.keys(write.fields),
      ...write.aliasAdditions.map((a) => `alias ${a}`),
      ...(supplierChange ? [supplierChange] : []),
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
    <div className="space-y-4">
      <SupplierPartsTable item={item} />

      <div>
        <p className="mb-1.5 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          Supplier aliases
          <InfoHint
            content={
              'Distributor order codes that all point at this same part (e.g. a DigiKey and an RS ' +
              'code for one resistor). **Universal Alias Mapping** lets a scan or search of any ' +
              'alias resolve to this item, so duplicates never creep in.'
            }
          />
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
