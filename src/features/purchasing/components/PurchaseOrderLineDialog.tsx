import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { Button, FormField, InfoHint, Input, Modal, Money, SelectField } from '@/components/foundry';
import type { CreatePurchaseOrderLineInput, PriceBreak } from '@/db/repositories';
import { effectiveUnitCostForQty } from '@/features/inventory/supplier-cost';
import { useFormatters } from '@/lib/useFormatters';

/**
 * A pickable item for a PO line, carrying the pricing needed to cost the line by quantity
 * (issue #37 — price breaks in the Order process). The dialog resolves the effective unit
 * cost for the ordered quantity: a manual item-level override wins outright; otherwise the
 * preferred supplier's flat cost refined by whichever price-break the quantity reaches.
 */
export interface LineItemOption {
  readonly id: string;
  readonly name: string;
  /** The manual item-level unit-cost override, or null — wins over supplier pricing. */
  readonly manualUnitCost: number | null;
  /** The preferred supplier part's flat unit cost (its qty-1 list price), or null. */
  readonly supplierUnitCost: number | null;
  /** The preferred supplier part's quantity price-breaks, ascending by qty; empty when none. */
  readonly priceBreaks: readonly PriceBreak[];
  /** The preferred supplier part's currency for the price display; null ⇒ the base currency. */
  readonly currency: string | null;
}

/**
 * Add a line to a purchase order (Inventory-depth Phase 62; price breaks — issue #37). The
 * optional item link defaults the unit cost from its effective cost for the ordered quantity,
 * updating live as the quantity crosses a supplier price-break; a line may also be free-text
 * (an item not yet in inventory). Design tokens only, British copy.
 */
export interface PurchaseOrderLineDialogProps {
  readonly open: boolean;
  readonly items: readonly LineItemOption[];
  readonly isSaving: boolean;
  readonly onSubmit: (input: CreatePurchaseOrderLineInput) => void;
  readonly onClose: () => void;
}

function optionalText(value: string): string | null {
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

/** A non-negative finite number is a usable price; anything else is treated as unset. */
function isUsablePrice(value: number | null): value is number {
  return value !== null && Number.isFinite(value) && value >= 0;
}

/** One displayable price tier: its threshold quantity and the unit cost that applies at it. */
interface DisplayTier {
  readonly qty: number;
  readonly unitCost: number;
}

export function PurchaseOrderLineDialog({
  open,
  items,
  isSaving,
  onSubmit,
  onClose,
}: PurchaseOrderLineDialogProps) {
  const f = useFormatters();
  const [itemId, setItemId] = useState('');
  const [description, setDescription] = useState('');
  const [orderedQty, setOrderedQty] = useState('1');
  const [unitCost, setUnitCost] = useState('');
  // Whether the user has typed their own unit cost. While false, the field auto-fills from
  // the item's effective cost for the quantity; once true we stop overwriting their value.
  const [costEdited, setCostEdited] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const chosen = useMemo(() => items.find((i) => i.id === itemId), [items, itemId]);

  // The ordered quantity as a usable positive integer, else 1 for pricing purposes (the
  // resolver qualifies no break for a non-positive quantity anyway; submit re-validates).
  const qtyNum = Number(orderedQty);
  const effectiveQty = Number.isInteger(qtyNum) && qtyNum > 0 ? qtyNum : 1;

  // The unit cost this item + quantity resolves to. Recomputed as either changes so the
  // field tracks the applicable price-break (unless the user has overridden it).
  const resolvedCost = useMemo(() => {
    if (!chosen) return null;
    return effectiveUnitCostForQty(
      { unitCost: chosen.manualUnitCost },
      [{ unitCost: chosen.supplierUnitCost, isPreferred: true, priceBreaks: chosen.priceBreaks }],
      effectiveQty,
    );
  }, [chosen, effectiveQty]);

  // Auto-fill the cost field from the resolved cost until the user types their own value.
  useEffect(() => {
    if (costEdited) return;
    setUnitCost(resolvedCost === null ? '' : String(resolvedCost));
  }, [resolvedCost, costEdited]);

  // Price-break tiers to surface for the chosen item — only when the preferred supplier
  // actually has breaks and no manual override is masking them (an override wins regardless
  // of quantity, so showing tiers that don't apply would mislead). Includes the flat qty-1
  // price as the first tier when the supplier has one.
  const tiers = useMemo<DisplayTier[]>(() => {
    if (!chosen || chosen.priceBreaks.length === 0) return [];
    if (isUsablePrice(chosen.manualUnitCost)) return [];
    const rows: DisplayTier[] = [];
    // Prepend the flat qty-1 price, unless the lowest break already starts at qty 1 (which
    // supersedes it) — otherwise the two would collide on the same `qty` key and render twice.
    if (isUsablePrice(chosen.supplierUnitCost) && chosen.priceBreaks[0]!.qty > 1) {
      rows.push({ qty: 1, unitCost: chosen.supplierUnitCost });
    }
    for (const b of chosen.priceBreaks) rows.push({ qty: b.qty, unitCost: b.unitCost });
    return rows;
  }, [chosen]);

  // The highest tier threshold at or below the ordered quantity is the active one.
  const activeTierQty = useMemo(() => {
    let active = 0;
    for (const tier of tiers) if (tier.qty <= effectiveQty) active = tier.qty;
    return active;
  }, [tiers, effectiveQty]);

  const handleItemChange = (id: string) => {
    setItemId(id);
    // A different item has a different price — let its cost flow back into the field.
    setCostEdited(false);
  };

  const handleTierClick = (qty: number) => {
    // Jump the order quantity to a break threshold so its price applies immediately.
    setOrderedQty(String(qty));
    setCostEdited(false);
  };

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    const qty = Number(orderedQty);
    if (!Number.isInteger(qty) || qty <= 0) {
      setError('Ordered quantity must be a whole number greater than zero.');
      return;
    }
    let cost: number | null = null;
    if (unitCost.trim().length > 0) {
      const n = Number(unitCost);
      if (!Number.isFinite(n) || n < 0) {
        setError('Unit cost must be zero or a positive amount.');
        return;
      }
      cost = n;
    }
    const desc = optionalText(description);
    if (itemId.length === 0 && desc === null) {
      setError('Choose an item or enter a description for this line.');
      return;
    }
    onSubmit({
      itemId: itemId.length === 0 ? null : itemId,
      description: desc,
      orderedQty: qty,
      unitCost: cost,
    });
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Add line"
      description="A part to order. Link an inventory item so received stock lands automatically."
    >
      <form onSubmit={handleSubmit} className="space-y-3" data-testid="po-line-form">
        <SelectField
          label="Item"
          hint="Link an inventory item, or leave unlinked and describe it below."
          value={itemId}
          onChange={handleItemChange}
          data-testid="po-line-item"
          options={[
            { value: '', label: '— Unlinked —' },
            ...items.map((i) => ({ value: i.id, label: i.name })),
          ]}
        />

        <FormField label="Description" hint="Used when no item is linked (e.g. a not-yet-stocked part).">
          <Input
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="e.g. 10k 0603 resistor"
            data-testid="po-line-description"
          />
        </FormField>

        <div className="grid grid-cols-2 gap-3">
          <FormField label="Ordered qty">
            <Input
              value={orderedQty}
              onChange={(e) => setOrderedQty(e.target.value)}
              inputMode="numeric"
              placeholder="1"
              data-testid="po-line-qty"
            />
          </FormField>
          <FormField label="Unit cost">
            <Input
              value={unitCost}
              onChange={(e) => {
                setUnitCost(e.target.value);
                setCostEdited(true);
              }}
              inputMode="decimal"
              placeholder="0.00"
              data-testid="po-line-cost"
            />
          </FormField>
        </div>

        {tiers.length > 0 ? (
          <div data-testid="po-line-price-breaks">
            <p className="mb-field-gap-compact flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Quantity price breaks
              <InfoHint
                content={
                  'The preferred supplier’s tiered pricing. The unit cost updates as your ' +
                  'ordered quantity reaches a break — select one to order that quantity.'
                }
              />
            </p>
            <div className="flex flex-wrap gap-1.5" role="group" aria-label="Quantity price breaks">
              {tiers.map((tier) => {
                const active = tier.qty === activeTierQty;
                return (
                  <button
                    key={tier.qty}
                    type="button"
                    onClick={() => handleTierClick(tier.qty)}
                    aria-pressed={active}
                    aria-label={`Order ${f.quantity(tier.qty)} or more at ${f.currency(
                      tier.unitCost,
                      chosen?.currency ?? undefined,
                    )} each`}
                    data-testid="po-line-price-break"
                    className={`rounded px-1.5 py-0.5 text-xs transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
                      active
                        ? 'bg-primary/15 font-medium text-foreground ring-1 ring-primary/40'
                        : 'bg-secondary/60 text-muted-foreground hover:bg-secondary'
                    }`}
                  >
                    {tier.qty}+:{' '}
                    <Money value={tier.unitCost} currency={chosen?.currency ?? undefined} formatters={f} />
                  </button>
                );
              })}
            </div>
          </div>
        ) : null}

        {error !== null && (
          <p role="alert" className="text-sm text-destructive" data-testid="po-line-error">
            {error}
          </p>
        )}

        <div className="flex justify-end gap-2 pt-1">
          <Button type="button" variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" disabled={isSaving} data-testid="po-line-save">
            Add line
          </Button>
        </div>
      </form>
    </Modal>
  );
}
