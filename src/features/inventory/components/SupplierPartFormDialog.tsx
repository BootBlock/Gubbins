import { useState, type FormEvent } from 'react';
import { Button, FormField, Input, Modal } from '@/components/foundry';
import type { CreateSupplierPartInput, PriceBreak, SupplierPart } from '@/db/repositories';

/**
 * Add/edit dialog for a single supplier part (§4 supplier facet; Phase 60). Local controlled
 * state keeps the form simple — every numeric field is optional, so it stores strings and
 * coerces on submit. Price-breaks are entered as a compact `qty:cost` list, one per line.
 *
 * Design tokens only (Foundry primitives). The dialog is closed with Escape or its scoped
 * Cancel button; the Foundry Modal's own "Close" (X) is the only element named "Close".
 */
export interface SupplierPartFormDialogProps {
  readonly open: boolean;
  /** The part being edited, or null when adding a new one. */
  readonly part: SupplierPart | null;
  readonly isSaving: boolean;
  readonly onSubmit: (input: CreateSupplierPartInput) => void;
  readonly onClose: () => void;
}

/** Serialise price-breaks to the `qty:cost` textarea form, ascending. */
function breaksToText(breaks: readonly PriceBreak[]): string {
  return breaks.map((b) => `${b.qty}:${b.unitCost}`).join('\n');
}

/** Parse the `qty:cost` textarea back to price-breaks, dropping malformed/blank lines. */
function parseBreaks(text: string): PriceBreak[] {
  const breaks: PriceBreak[] = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    const [qtyRaw, costRaw] = trimmed.split(':');
    const qty = Number(qtyRaw);
    const unitCost = Number(costRaw);
    if (!Number.isFinite(qty) || qty <= 0 || !Number.isFinite(unitCost) || unitCost < 0) continue;
    breaks.push({ qty, unitCost });
  }
  return breaks;
}

/**
 * Sentinel for an optional numeric field that was filled in but is not valid (as opposed
 * to a blank field, which is a legitimate `null`). Lets {@link handleSubmit} tell "left
 * empty" apart from "typed something nonsensical" and surface an error rather than silently
 * coercing to `null` (or letting the repository's CHECK constraint throw with no feedback).
 */
const INVALID = Symbol('invalid');

/** Coerce an optional non-negative cost: blank → null, a bad/negative value → INVALID. */
function optionalCost(value: string): number | null | typeof INVALID {
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  const n = Number(trimmed);
  return Number.isFinite(n) && n >= 0 ? n : INVALID;
}

/** Coerce an optional positive whole number (pack/MOQ): blank → null, otherwise INVALID. */
function optionalCount(value: string): number | null | typeof INVALID {
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  const n = Number(trimmed);
  return Number.isInteger(n) && n > 0 ? n : INVALID;
}

function optionalText(value: string): string | null {
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

export function SupplierPartFormDialog({
  open,
  part,
  isSaving,
  onSubmit,
  onClose,
}: SupplierPartFormDialogProps) {
  const [supplierName, setSupplierName] = useState(part?.supplierName ?? '');
  const [orderCode, setOrderCode] = useState(part?.orderCode ?? '');
  const [unitCost, setUnitCost] = useState(part?.unitCost != null ? String(part.unitCost) : '');
  const [currency, setCurrency] = useState(part?.currency ?? '');
  const [packQty, setPackQty] = useState(part?.packQty != null ? String(part.packQty) : '');
  const [minOrderQty, setMinOrderQty] = useState(part?.minOrderQty != null ? String(part.minOrderQty) : '');
  const [url, setUrl] = useState(part?.url ?? '');
  const [breaksText, setBreaksText] = useState(part ? breaksToText(part.priceBreaks) : '');
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    if (supplierName.trim().length === 0) {
      setError('A supplier name is required.');
      return;
    }
    const cost = optionalCost(unitCost);
    if (cost === INVALID) {
      setError('Unit cost must be zero or a positive amount.');
      return;
    }
    const pack = optionalCount(packQty);
    if (pack === INVALID) {
      setError('Pack quantity must be a whole number greater than zero.');
      return;
    }
    const minOrder = optionalCount(minOrderQty);
    if (minOrder === INVALID) {
      setError('Minimum order quantity must be a whole number greater than zero.');
      return;
    }
    onSubmit({
      supplierName: supplierName.trim(),
      orderCode: optionalText(orderCode),
      unitCost: cost,
      currency: optionalText(currency),
      packQty: pack,
      minOrderQty: minOrder,
      url: optionalText(url),
      priceBreaks: parseBreaks(breaksText),
    });
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={part ? 'Edit supplier' : 'Add supplier'}
      description="A supplier's order code, pricing and quantity price-breaks for this item."
    >
      <form onSubmit={handleSubmit} className="space-y-3" data-testid="supplier-part-form">
        <FormField label="Supplier">
          <Input
            value={supplierName}
            onChange={(e) => {
              setSupplierName(e.target.value);
              setError(null);
            }}
            placeholder="e.g. DigiKey"
            data-testid="supplier-part-name"
            autoFocus
          />
        </FormField>

        <div className="grid grid-cols-2 gap-3">
          <FormField label="Order code">
            <Input
              value={orderCode}
              onChange={(e) => setOrderCode(e.target.value)}
              placeholder="Supplier part no."
              data-testid="supplier-part-order-code"
            />
          </FormField>
          <FormField
            label="URL"
            hint="The supplier's product page. A re-scrape matches a supplier by this link's host."
          >
            <Input
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://…"
              inputMode="url"
            />
          </FormField>
        </div>

        <div className="grid grid-cols-3 gap-3">
          <FormField label="Unit cost">
            <Input
              value={unitCost}
              onChange={(e) => setUnitCost(e.target.value)}
              inputMode="decimal"
              placeholder="0.00"
              data-testid="supplier-part-unit-cost"
            />
          </FormField>
          <FormField
            label="Currency"
            hint="ISO code (e.g. **USD**). Blank uses your base currency; it is stored for fidelity only and never converted."
          >
            <Input
              value={currency}
              onChange={(e) => setCurrency(e.target.value.toUpperCase())}
              maxLength={3}
              placeholder="—"
            />
          </FormField>
          <FormField label="Pack qty">
            <Input
              value={packQty}
              onChange={(e) => setPackQty(e.target.value)}
              inputMode="numeric"
              placeholder="1"
            />
          </FormField>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <FormField label="Min order qty">
            <Input
              value={minOrderQty}
              onChange={(e) => setMinOrderQty(e.target.value)}
              inputMode="numeric"
              placeholder="1"
            />
          </FormField>
        </div>

        <FormField
          label="Price breaks"
          hint="Quantity price-breaks, one per line as `qty:unitCost` (e.g. `10:0.20`). The cheaper rate applies at that quantity and above."
        >
          <textarea
            value={breaksText}
            onChange={(e) => setBreaksText(e.target.value)}
            rows={3}
            placeholder={'100:0.10\n1000:0.08'}
            className="h-auto min-h-[4.5rem] w-full resize-y rounded-lg border border-border bg-input/40 px-3 py-2 text-sm leading-relaxed text-foreground shadow-sm outline-none transition-colors placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/40"
            data-testid="supplier-part-breaks"
          />
        </FormField>

        {error !== null && (
          <p role="alert" className="text-sm text-destructive" data-testid="supplier-part-error">
            {error}
          </p>
        )}

        <div className="flex justify-end gap-2 pt-1">
          <Button type="button" variant="outline" onClick={onClose} data-testid="supplier-part-cancel">
            Cancel
          </Button>
          <Button type="submit" variant="primary" disabled={isSaving} data-testid="supplier-part-save">
            {part ? 'Save' : 'Add supplier'}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
