import { useRef, useState, type FormEvent } from 'react';
import { Button, FormField, Input, Modal } from '@/components/foundry';
import type { CreatePurchaseOrderInput } from '@/db/repositories';

/**
 * Create a new (DRAFT) purchase order (Inventory-depth Phase 62). Local controlled state;
 * only the supplier name is required. Design tokens only (Foundry primitives), British copy.
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
  const [supplierName, setSupplierName] = useState('');
  const [reference, setReference] = useState('');
  const [currency, setCurrency] = useState('');
  const [error, setError] = useState<string | null>(null);
  const supplierRef = useRef<HTMLInputElement>(null);

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    if (supplierName.trim().length === 0) {
      setError('A supplier name is required.');
      return;
    }
    onSubmit({
      supplierName: supplierName.trim(),
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
        <FormField label="Supplier">
          <Input
            ref={supplierRef}
            value={supplierName}
            onChange={(e) => {
              setSupplierName(e.target.value);
              setError(null);
            }}
            placeholder="e.g. DigiKey"
            data-testid="po-supplier-name"
          />
        </FormField>

        <div className="grid grid-cols-2 gap-3">
          <FormField label="Reference" hint="Your PO number or order reference (optional).">
            <Input
              value={reference}
              onChange={(e) => setReference(e.target.value)}
              placeholder="PO-2026-001"
              data-testid="po-reference"
            />
          </FormField>
          <FormField
            label="Currency"
            hint="ISO code (e.g. **USD**). Blank uses your base currency; stored for fidelity only, never converted."
          >
            <Input
              value={currency}
              onChange={(e) => setCurrency(e.target.value.toUpperCase())}
              maxLength={3}
              placeholder="—"
            />
          </FormField>
        </div>

        {error !== null && (
          <p role="alert" className="text-sm text-destructive" data-testid="po-create-error">
            {error}
          </p>
        )}

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
