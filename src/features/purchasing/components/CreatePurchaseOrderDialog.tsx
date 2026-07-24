import { useRef, useState, type FormEvent } from 'react';
import { Button, CurrencyAutocompleteField, FormField, Input, Modal } from '@/components/foundry';
import type { CreatePurchaseOrderInput } from '@/db/repositories';
import { useT } from '@/features/i18n';
import { EMPTY_SUPPLIER_VALUE, SupplierPicker, supplierRefFrom } from '@/features/suppliers';

/**
 * Create a new (DRAFT) purchase order (Inventory-depth Phase 62). Local controlled state;
 * only the supplier is required. Design tokens only (Foundry primitives), British copy.
 *
 * The supplier is named through the shared {@link SupplierPicker} (issue #384) rather than a
 * bare text field: this dialog is the most-used way an order comes into existence, so a
 * free-text box here was the single largest source of near-duplicate suppliers. The picker
 * offers the ones you already have and folds a differently-spelled name onto the existing
 * supplier, while still letting a brand-new name be typed straight in.
 */
export interface CreatePurchaseOrderDialogProps {
  readonly open: boolean;
  readonly isSaving: boolean;
  readonly onSubmit: (input: CreatePurchaseOrderInput) => void;
  readonly onClose: () => void;
}

function optionalText(value: string): string | null {
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

export function CreatePurchaseOrderDialog({
  open,
  isSaving,
  onSubmit,
  onClose,
}: CreatePurchaseOrderDialogProps) {
  const t = useT();
  const [supplier, setSupplier] = useState(EMPTY_SUPPLIER_VALUE);
  const [reference, setReference] = useState('');
  const [currency, setCurrency] = useState('');
  const [error, setError] = useState<string | null>(null);
  const supplierRef = useRef<HTMLInputElement>(null);

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    // A blank field is the only rejection: an unrecognised *name* is perfectly valid — the
    // repository resolves it onto the matching supplier, or creates one.
    const ref = supplierRefFrom(supplier);
    if (ref === null) {
      setError(t('supplier.picker.required'));
      return;
    }
    onSubmit({
      supplier: ref,
      reference: optionalText(reference),
      currency: optionalText(currency),
    });
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="New purchase order"
      description="A supplier-keyed order. Add the parts to order as lines once it is created."
      initialFocusRef={supplierRef}
    >
      <form onSubmit={handleSubmit} className="space-y-3" data-testid="po-create-form">
        <SupplierPicker
          inputRef={supplierRef}
          value={supplier}
          onChange={(next) => {
            setSupplier(next);
            setError(null);
          }}
          {...(error !== null ? { error } : {})}
          data-testid="po-supplier-name"
        />

        <div className="grid grid-cols-2 gap-3">
          <FormField label="Reference" hint="Your PO number or order reference (optional).">
            <Input
              value={reference}
              onChange={(e) => setReference(e.target.value)}
              placeholder="PO-2026-001"
              data-testid="po-reference"
            />
          </FormField>
          <CurrencyAutocompleteField
            label="Currency"
            hint="Pick one from the list, or type its three-letter ISO 4217 code (e.g. **USD**). Leave it blank to use your base currency; a chosen currency is stored for fidelity only, never converted."
            value={currency}
            onChange={setCurrency}
            placeholder="Use base currency"
          />
        </div>

        <div className="flex justify-end gap-2 pt-1">
          <Button type="button" variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" disabled={isSaving} data-testid="po-create-save">
            Create order
          </Button>
        </div>
      </form>
    </Modal>
  );
}
