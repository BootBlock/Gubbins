import { useState } from 'react';
import { Button, InfoHint } from '@/components/foundry';
import { AddIcon, DeleteIcon, EditIcon, LinkIcon, NotPreferredIcon, PreferredIcon } from '@/components/icons';
import type { CreateSupplierPartInput, Item, SupplierPart } from '@/db/repositories';
import { useFormatters } from '@/lib/useFormatters';
import {
  useCreateSupplierPart,
  useDeleteSupplierPart,
  useSetPreferredSupplierPart,
  useUpdateSupplierPart,
} from '../mutations';
import { useItemSupplierParts } from '../queries';
import { SupplierPartFormDialog } from './SupplierPartFormDialog';
import { SupplierPartPriceHistory } from './SupplierPartPriceHistory';

/**
 * Editable supplier-parts table (§4 supplier facet; Phase 60). Models N suppliers per item —
 * add/edit/remove rows, star the single preferred supplier, and show quantity price-breaks.
 * Design tokens only (Foundry primitives + semantic tokens), British English.
 */
export function SupplierPartsTable({ item }: { item: Item }) {
  const { data: parts } = useItemSupplierParts(item.id);
  const create = useCreateSupplierPart();
  const update = useUpdateSupplierPart();
  const setPreferred = useSetPreferredSupplierPart();
  const remove = useDeleteSupplierPart();
  const fmt = useFormatters();

  // null = closed; 'new' = adding; a SupplierPart = editing that row.
  const [editing, setEditing] = useState<SupplierPart | 'new' | null>(null);

  const handleSubmit = (input: CreateSupplierPartInput) => {
    if (editing && editing !== 'new') {
      update.mutate({ id: editing.id, itemId: item.id, input }, { onSuccess: () => setEditing(null) });
    } else {
      create.mutate({ itemId: item.id, input }, { onSuccess: () => setEditing(null) });
    }
  };

  const list = parts ?? [];

  return (
    <div>
      <div className="mb-1.5 flex items-center justify-between">
        <p className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          Suppliers
          <InfoHint
            content={
              'Each supplier offering this part — its order code, unit cost and quantity ' +
              'price-breaks. **Star** the preferred supplier; its cost feeds valuation unless ' +
              "you've set a manual unit cost on the item."
            }
          />
        </p>
        <Button variant="outline" size="sm" onClick={() => setEditing('new')} data-testid="supplier-part-add">
          <AddIcon />
          Add supplier
        </Button>
      </div>

      {list.length === 0 ? (
        <p className="text-sm text-muted-foreground">No suppliers recorded yet.</p>
      ) : (
        <ul
          className="divide-y divide-border rounded-lg border border-border"
          data-testid="supplier-parts-list"
        >
          {list.map((part) => (
            <li key={part.id} className="flex items-start gap-3 p-3" data-testid="supplier-part-row">
              <button
                type="button"
                onClick={() => setPreferred.mutate({ id: part.id, itemId: item.id })}
                disabled={part.isPreferred}
                aria-label={part.isPreferred ? 'Preferred supplier' : 'Make preferred'}
                title={part.isPreferred ? 'Preferred supplier' : 'Make preferred'}
                data-testid="supplier-part-prefer"
                className="mt-0.5 rounded-md p-1 text-muted-foreground transition-colors hover:bg-secondary/60 hover:text-foreground disabled:cursor-default disabled:text-glyph-success disabled:hover:bg-transparent [&_svg]:size-4"
              >
                {part.isPreferred ? <PreferredIcon /> : <NotPreferredIcon />}
              </button>

              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                  <span className="font-medium">{part.supplierName}</span>
                  {part.isPreferred ? (
                    <span className="rounded-full bg-glyph-success/10 px-2 py-0.5 text-xs font-medium text-glyph-success">
                      Preferred
                    </span>
                  ) : null}
                  {part.orderCode ? (
                    <span className="text-xs text-muted-foreground">{part.orderCode}</span>
                  ) : null}
                </div>

                <div className="mt-0.5 flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-muted-foreground">
                  {part.unitCost !== null ? (
                    <span className="text-foreground">
                      {fmt.currency(part.unitCost)}
                      {part.currency ? ` ${part.currency}` : ''}
                    </span>
                  ) : (
                    <span>No price</span>
                  )}
                  {part.packQty !== null ? <span>Pack {part.packQty}</span> : null}
                  {part.minOrderQty !== null ? <span>MOQ {part.minOrderQty}</span> : null}
                  {part.url ? (
                    <a
                      href={part.url}
                      target="_blank"
                      rel="noreferrer noopener"
                      className="inline-flex items-center gap-1 text-primary hover:underline [&_svg]:size-3"
                    >
                      <LinkIcon />
                      Open
                    </a>
                  ) : null}
                </div>

                {part.priceBreaks.length > 0 ? (
                  <div className="mt-1 flex flex-wrap gap-1.5">
                    {part.priceBreaks.map((b) => (
                      <span
                        key={b.qty}
                        className="rounded bg-secondary/60 px-1.5 py-0.5 text-xs text-muted-foreground"
                      >
                        {b.qty}+: {fmt.currency(b.unitCost)}
                      </span>
                    ))}
                  </div>
                ) : null}

                <SupplierPartPriceHistory itemId={item.id} supplierPartId={part.id} />
              </div>

              <div className="flex shrink-0 gap-1">
                <Button
                  variant="ghost"
                  size="icon"
                  className="size-8"
                  onClick={() => setEditing(part)}
                  aria-label={`Edit ${part.supplierName}`}
                  data-testid="supplier-part-edit"
                >
                  <EditIcon />
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  className="size-8 text-destructive hover:bg-destructive/10"
                  onClick={() => remove.mutate({ id: part.id, itemId: item.id })}
                  aria-label={`Remove ${part.supplierName}`}
                  data-testid="supplier-part-remove"
                >
                  <DeleteIcon />
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}

      {editing !== null ? (
        <SupplierPartFormDialog
          open
          part={editing === 'new' ? null : editing}
          isSaving={create.isPending || update.isPending}
          onSubmit={handleSubmit}
          onClose={() => setEditing(null)}
        />
      ) : null}
    </div>
  );
}
