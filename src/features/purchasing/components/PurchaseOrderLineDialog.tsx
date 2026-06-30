import { useState, type FormEvent } from 'react';
import { Button, FormField, Input, Modal, Select } from '@/components/foundry';
import type { CreatePurchaseOrderLineInput } from '@/db/repositories';

/** A pickable item for a PO line, with its default (preferred-supplier) unit cost. */
export interface LineItemOption {
  readonly id: string;
  readonly name: string;
  /** The effective unit cost (manual override, else preferred supplier) — defaults the field. */
  readonly defaultUnitCost: number | null;
}

/**
 * Add a line to a purchase order (Inventory-depth Phase 62). The optional item link defaults
 * the unit cost from the Phase-60 effective cost (preferred supplier / manual override); a
 * line may also be free-text (an item not yet in inventory). Design tokens only, British copy.
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

export function PurchaseOrderLineDialog({
  open,
  items,
  isSaving,
  onSubmit,
  onClose,
}: PurchaseOrderLineDialogProps) {
  const [itemId, setItemId] = useState('');
  const [description, setDescription] = useState('');
  const [orderedQty, setOrderedQty] = useState('1');
  const [unitCost, setUnitCost] = useState('');
  const [error, setError] = useState<string | null>(null);

  const handleItemChange = (id: string) => {
    setItemId(id);
    // Default the unit cost from the chosen item's effective cost (only when the user
    // hasn't already typed one), so a priced part pre-fills sensibly.
    const chosen = items.find((i) => i.id === id);
    if (chosen && chosen.defaultUnitCost != null && unitCost.trim().length === 0) {
      setUnitCost(String(chosen.defaultUnitCost));
    }
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
        <FormField label="Item" hint="Link an inventory item, or leave unlinked and describe it below.">
          <Select
            value={itemId}
            onChange={(e) => handleItemChange(e.target.value)}
            data-testid="po-line-item"
          >
            <option value="">— Unlinked —</option>
            {items.map((i) => (
              <option key={i.id} value={i.id}>
                {i.name}
              </option>
            ))}
          </Select>
        </FormField>

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
              onChange={(e) => setUnitCost(e.target.value)}
              inputMode="decimal"
              placeholder="0.00"
              data-testid="po-line-cost"
            />
          </FormField>
        </div>

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
