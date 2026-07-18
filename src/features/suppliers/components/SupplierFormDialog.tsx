import { useMemo, useRef, useState } from 'react';
import { Button, FormField, Input, Modal, Textarea } from '@/components/foundry';
import { DeleteIcon } from '@/components/icons';
import type { SupplierWithCounts } from '@/db/repositories';
import { useT } from '@/features/i18n';
import { supplierNameKey } from '@/lib/supplier-name';
import { useCreateSupplier, useDeleteSupplier, useUpdateSupplier } from '../mutations';
import { useErrorMessage } from '@/features/errors';

export interface SupplierFormDialogProps {
  /** The supplier being edited, or `null` to add a new one. */
  readonly supplier: SupplierWithCounts | null;
  /**
   * Every *other* supplier in the dictionary, used to catch a rename collision before it reaches
   * the database so the user is offered the merge rather than a bare constraint error.
   */
  readonly others: readonly SupplierWithCounts[];
  readonly onClose: () => void;
  /** Ask the screen to open the merge flow with this supplier pre-selected as the source. */
  readonly onMerge: (source: SupplierWithCounts) => void;
  /** Announce a completed write on the screen's live region. */
  readonly onAnnounce: (message: string) => void;
}

/**
 * Add or edit one supplier — name, storefront URL, default currency and a note — plus the
 * delete affordance for an editable one.
 *
 * Two behaviours carry the weight of issue #384:
 *
 * - **A rename that collides is not a rename.** Supplier names are canonical (case, spacing and
 *   punctuation are folded), so renaming `RS-Components` to `RS Components` when that supplier
 *   already exists would mean two rows claiming one identity. The dictionary refuses it and this
 *   dialog offers the merge instead, which is what the user actually meant.
 * - **Delete is always allowed, but never silent.** Supplier parts cascade away with the supplier;
 *   purchase orders do not — `purchase_orders.supplier_id` is ON DELETE SET NULL, so an order keeps
 *   its record of what was spent and simply stops naming a supplier. Both consequences are stated
 *   before the confirm, because neither is visible from a name alone. Merging is offered alongside:
 *   it is the right move for a *duplicate*, where the orders should keep naming a supplier.
 */
export function SupplierFormDialog({
  supplier,
  others,
  onClose,
  onMerge,
  onAnnounce,
}: SupplierFormDialogProps) {
  const t = useT();
  const nameRef = useRef<HTMLInputElement>(null);
  const isEdit = supplier !== null;

  const [name, setName] = useState(supplier?.name ?? '');
  const [url, setUrl] = useState(supplier?.url ?? '');
  const [currency, setCurrency] = useState(supplier?.currency ?? '');
  const [note, setNote] = useState(supplier?.note ?? '');
  const [error, setError] = useState<string | null>(null);
  const describeError = useErrorMessage();
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  const create = useCreateSupplier();
  const update = useUpdateSupplier();
  const remove = useDeleteSupplier();
  const busy = create.isPending || update.isPending || remove.isPending;

  const trimmed = name.trim();
  // The folded identity key is what the database's UNIQUE index actually compares, so checking
  // it here catches exactly the collisions the write would have rejected — no more, no fewer.
  const clash = useMemo(() => {
    const key = supplierNameKey(trimmed);
    if (key.length === 0) return undefined;
    return others.find((other) => supplierNameKey(other.name) === key);
  }, [trimmed, others]);

  const submit = () => {
    if (trimmed.length === 0) {
      setError(t('suppliers.form.nameRequired'));
      return;
    }
    if (clash) {
      setError(t('suppliers.form.clash', { vars: { name: clash.name } }));
      return;
    }
    setError(null);
    const input = {
      name: trimmed,
      url: url.trim() || null,
      currency: currency.trim() || null,
      note: note.trim() || null,
    };
    const onError = (e: unknown) => setError(describeError(e, t('suppliers.form.error')));

    if (isEdit) {
      update.mutate(
        { id: supplier.id, input },
        {
          onSuccess: () => {
            onAnnounce(t('suppliers.form.saved', { vars: { name: trimmed } }));
            onClose();
          },
          onError,
        },
      );
    } else {
      create.mutate(input, {
        onSuccess: () => {
          onAnnounce(t('suppliers.form.added', { vars: { name: trimmed } }));
          onClose();
        },
        onError,
      });
    }
  };

  const doDelete = () => {
    if (!supplier) return;
    setError(null);
    remove.mutate(supplier.id, {
      onSuccess: () => {
        onAnnounce(t('suppliers.delete.done', { vars: { name: supplier.name } }));
        onClose();
      },
      onError: (e) => setError(describeError(e, t('suppliers.delete.error'))),
    });
  };

  return (
    <Modal
      open
      onClose={onClose}
      title={isEdit ? t('suppliers.form.edit.title') : t('suppliers.form.create.title')}
      description={isEdit ? t('suppliers.form.edit.description') : t('suppliers.form.create.description')}
      initialFocusRef={nameRef}
    >
      <div className="space-y-5">
        <FormField label={t('suppliers.form.name')}>
          <Input
            ref={nameRef}
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={t('suppliers.form.name.placeholder')}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                submit();
              }
            }}
          />
        </FormField>

        <FormField label={t('suppliers.form.url')} hint={t('suppliers.form.url.hint')}>
          <Input
            type="url"
            inputMode="url"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder={t('suppliers.form.url.placeholder')}
          />
        </FormField>

        <FormField label={t('suppliers.form.currency')} hint={t('suppliers.form.currency.hint')}>
          <Input
            value={currency}
            onChange={(e) => setCurrency(e.target.value)}
            placeholder={t('suppliers.form.currency.placeholder')}
            maxLength={8}
          />
        </FormField>

        <FormField label={t('suppliers.form.note')}>
          <Textarea
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder={t('suppliers.form.note.placeholder')}
            rows={3}
          />
        </FormField>

        {error ? (
          <div className="space-y-field-gap-compact">
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
            {clash && supplier ? (
              // The rename the user asked for *is* a merge — offer it directly rather than
              // making them find the flow and re-pick both sides.
              <Button variant="outline" onClick={() => onMerge(supplier)} disabled={busy}>
                {t('suppliers.form.clash.mergeInstead')}
              </Button>
            ) : null}
          </div>
        ) : null}

        {isEdit ? (
          <div className="space-y-field-gap-compact border-t border-border pt-4">
            {confirmingDelete ? (
              <div className="space-y-field-gap-compact" data-testid="supplier-delete-confirm">
                <p className="text-sm text-foreground">{t('suppliers.delete.confirm')}</p>
                {/* Neither consequence is visible from a name alone, so both are spelled out —
                    what goes with the supplier, and what survives it without naming one. */}
                {supplier.partCount > 0 ? (
                  <p className="text-xs text-muted-foreground">
                    {t('suppliers.delete.warnParts', {
                      vars: { count: supplier.partCount, n: supplier.partCount },
                    })}
                  </p>
                ) : null}
                {supplier.orderCount > 0 ? (
                  <p className="text-xs text-muted-foreground">
                    {t('suppliers.delete.warnOrders', {
                      vars: { count: supplier.orderCount, n: supplier.orderCount },
                    })}
                  </p>
                ) : null}
                <div className="flex flex-wrap items-center gap-2">
                  <Button variant="destructive" onClick={doDelete} disabled={busy}>
                    {t('suppliers.delete.action')}
                  </Button>
                  <Button variant="ghost" onClick={() => setConfirmingDelete(false)} disabled={busy}>
                    {t('suppliers.delete.keep')}
                  </Button>
                </div>
              </div>
            ) : (
              <Button variant="destructive" onClick={() => setConfirmingDelete(true)} disabled={busy}>
                <DeleteIcon aria-hidden />
                {t('suppliers.delete.start')}
              </Button>
            )}
            {/* Merging stays on offer — for a duplicate it is what the user actually wants, since
                the orders keep naming a supplier instead of being unlinked. */}
            <Button variant="outline" onClick={() => onMerge(supplier)} disabled={busy}>
              {t('suppliers.delete.mergeInstead')}
            </Button>
          </div>
        ) : null}

        <div className="flex items-center justify-end gap-2 border-t border-border pt-4">
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            {t('suppliers.form.cancel')}
          </Button>
          <Button onClick={submit} disabled={busy || trimmed.length === 0}>
            {isEdit ? t('suppliers.form.save') : t('suppliers.form.create')}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
