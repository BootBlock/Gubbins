import { useRef, useState, type FormEvent } from 'react';
import { AutocompleteField, Button, FormField, Input, Modal, Textarea } from '@/components/foundry';
import type { CreateSupplierPartInput, PriceBreak, SupplierPart } from '@/db/repositories';
import { SUPPORTED_SUPPLIER_LABELS } from '@/features/scraping';
import { CURRENCY_OPTIONS } from '@/features/settings/settings';
import { SupplierPicker, supplierRefFrom, type SupplierPickerValue } from '@/features/suppliers';

/**
 * URL-field help: which suppliers the companion extension can scrape, listed from the
 * live parser registry so this can never fall out of step with what actually works.
 */
const URL_HINT = [
  "The supplier's product page — paste the full `https://…` link.",
  '',
  'With the companion browser extension installed, a **re-scrape** reads live price, order ' +
    "code and other details straight from this page, matching the supplier by the link's host. " +
    `Dedicated scrapers exist for: **${SUPPORTED_SUPPLIER_LABELS.join('**, **')}**. Any other ` +
    'product page is still read on a best-effort basis from its structured metadata.',
].join('\n');

/** Help for the auto-completing Currency field (now drives the displayed symbol). */
const CURRENCY_HINT =
  'Pick from the list (open it with the ▾ arrow) or type any ISO-4217 code (e.g. **EUR**, ' +
  "**JPY**). This supplier's costs are then shown with that currency's own symbol — e.g. " +
  '`€1.23` — exactly as entered and **never converted**. Leave blank to use your base ' +
  'currency (set in Settings).';

/**
 * Currency picker options as `"CODE — Name"` strings (e.g. `"GBP — British Pound"`), so the
 * dropdown is self-explanatory to a user who does not know the codes. Selecting one is stripped
 * back to the bare code by {@link codeFromCurrencyChoice}; typing a code stands as-is.
 */
const CURRENCY_SUGGESTIONS = CURRENCY_OPTIONS.map((c) => `${c.value} — ${c.label}`);

/** Reduce a Currency-field value to its ISO code: `"GBP — British Pound"` → `"GBP"`. */
function codeFromCurrencyChoice(value: string): string {
  return value.split(' — ')[0]!.trim().toUpperCase();
}

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
  // Seeded from the part's *resolved* supplier when editing, so re-saving an untouched form
  // keeps it pointed at the same row rather than re-resolving its name.
  const [supplier, setSupplier] = useState<SupplierPickerValue>({
    supplierId: part?.supplierId ?? null,
    name: part?.supplierName ?? '',
  });
  const [orderCode, setOrderCode] = useState(part?.orderCode ?? '');
  const [unitCost, setUnitCost] = useState(part?.unitCost != null ? String(part.unitCost) : '');
  const [currency, setCurrency] = useState(part?.currency ?? '');
  const [packQty, setPackQty] = useState(part?.packQty != null ? String(part.packQty) : '');
  const [minOrderQty, setMinOrderQty] = useState(part?.minOrderQty != null ? String(part.minOrderQty) : '');
  const [url, setUrl] = useState(part?.url ?? '');
  const [breaksText, setBreaksText] = useState(part ? breaksToText(part.priceBreaks) : '');
  const [error, setError] = useState<string | null>(null);
  const nameRef = useRef<HTMLInputElement>(null);

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    const supplierRef = supplierRefFrom(supplier);
    if (supplierRef === null) {
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
      supplier: supplierRef,
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
      initialFocusRef={nameRef}
    >
      <form onSubmit={handleSubmit} className="space-y-3" data-testid="supplier-part-form">
        <SupplierPicker
          hint={
            'The distributor or shop you buy this part from (e.g. **DigiKey**, **RS**, or a local ' +
            'supplier). **Required.** An item can list several suppliers; **star** one in the table ' +
            "to mark it preferred — its unit cost feeds the item's valuation unless you've set a " +
            'manual cost on the item.\n\nPick a supplier you already use, or type a new name to add ' +
            'one. Spelling, spacing and punctuation are ignored when matching, so a supplier is ' +
            'never duplicated by a second way of writing it.'
          }
          inputRef={nameRef}
          value={supplier}
          onChange={(value) => {
            setSupplier(value);
            setError(null);
          }}
          data-testid="supplier-part-name"
        />

        <div className="grid grid-cols-2 gap-3">
          <FormField
            label="Order code"
            hint={
              "The supplier's own part number / SKU for this item — *their* **order code**, not the " +
              "manufacturer's MPN. Used to reorder and to recognise this supplier on a re-scrape. Optional."
            }
          >
            <Input
              value={orderCode}
              onChange={(e) => setOrderCode(e.target.value)}
              placeholder="Supplier part no."
              data-testid="supplier-part-order-code"
            />
          </FormField>
          <FormField label="URL" hint={URL_HINT} hintSize="md">
            <Input
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://…"
              inputMode="url"
            />
          </FormField>
        </div>

        <div className="grid grid-cols-3 gap-3">
          <FormField
            label="Unit cost"
            hint={
              'Price for a **single unit** at this supplier, in the currency beside it. Feeds ' +
              'valuation and cost roll-ups. Enter the base per-unit price here; tiered quantity ' +
              'pricing goes in **Price breaks** below. Optional — leave blank if unknown.'
            }
          >
            <Input
              value={unitCost}
              onChange={(e) => setUnitCost(e.target.value)}
              inputMode="decimal"
              placeholder="0.00"
              data-testid="supplier-part-unit-cost"
            />
          </FormField>
          <AutocompleteField
            label="Currency"
            hint={CURRENCY_HINT}
            value={currency}
            onChange={(value) => setCurrency(codeFromCurrencyChoice(value))}
            suggestions={CURRENCY_SUGGESTIONS}
            maxOptions={CURRENCY_SUGGESTIONS.length}
            maxLength={3}
            placeholder="—"
            data-testid="supplier-part-currency"
          />
          <FormField
            label="Pack qty"
            hint={
              'How many units come in one orderable pack (e.g. a reel of **1000**). Informational — ' +
              'it does **not** multiply the unit cost. Blank means single units. Whole number above zero.'
            }
          >
            <Input
              value={packQty}
              onChange={(e) => setPackQty(e.target.value)}
              inputMode="numeric"
              placeholder="1"
            />
          </FormField>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <FormField
            label="Min order qty"
            hint={
              'The smallest quantity this supplier will sell — their **MOQ**. Informational, for ' +
              'reorder planning; it does not change the cost. Blank means no minimum. Whole number above zero.'
            }
          >
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
          <Textarea
            value={breaksText}
            onChange={(e) => setBreaksText(e.target.value)}
            rows={3}
            placeholder={'100:0.10\n1000:0.08'}
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
