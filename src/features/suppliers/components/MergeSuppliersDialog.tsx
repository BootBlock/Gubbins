import { useEffect, useState } from 'react';
import { Button, Modal, Surface } from '@/components/foundry';
import { MergeIcon, WarningIcon } from '@/components/icons';
import type { SupplierWithCounts } from '@/db/repositories';
import { useT } from '@/features/i18n';
import { useMergeSuppliers } from '../mutations';
import { useErrorMessage } from '@/features/errors';
import { NO_SUPPLIER_CHOICE, type SupplierChoice } from '../supplier-choice';
import { SupplierSearchField } from './SupplierSearchField';

export interface MergeSuppliersDialogProps {
  /** Pre-selected source (the supplier the user was looking at), if any. */
  readonly initialSource?: SupplierWithCounts;
  readonly onClose: () => void;
  readonly onAnnounce: (message: string) => void;
}

/**
 * Fold one supplier into another (issue #384).
 *
 * The repair path for a dictionary that accumulated duplicates before suppliers were canonical
 * — `RS Components` and `RS-Components` as two unrelated rows — and the way to retire a supplier
 * while its purchase orders keep naming one. (Deleting it is also allowed: the orders are
 * ON DELETE SET NULL, so they survive unlinked. Merging is what a *duplicate* wants.)
 *
 * Merging re-points every supplier part and purchase order at the target and then deletes the
 * source, in one transaction. That is irreversible, and the counts involved are not visible from
 * a name alone, so the dialog states exactly what will move before the confirm is offered — the
 * user should never have to guess how much history is riding on the choice.
 *
 * Both sides are chosen by **searching the dictionary** rather than from a dropdown built out of
 * whatever page the screen happened to load (issue #386). A duplicate pair that both sort late
 * is precisely the case merge exists for, so neither side may depend on how long the list is.
 */
export function MergeSuppliersDialog({ initialSource, onClose, onAnnounce }: MergeSuppliersDialogProps) {
  const t = useT();
  const merge = useMergeSuppliers();

  const [sourceChoice, setSourceChoice] = useState<SupplierChoice>(
    initialSource ? { text: initialSource.name, supplier: initialSource } : NO_SUPPLIER_CHOICE,
  );
  const [targetChoice, setTargetChoice] = useState<SupplierChoice>(NO_SUPPLIER_CHOICE);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const describeError = useErrorMessage();

  const source = sourceChoice.supplier;
  const target = targetChoice.supplier;

  // Changing either side invalidates a confirm the user already gave — they would otherwise be
  // one click from merging a pair they never read the preview for.
  useEffect(() => {
    setConfirming(false);
  }, [source?.id, target?.id]);

  // Picking the current target as the source would leave the two equal; drop the stale target
  // outright — text and all — rather than leaving a name in a field that no longer selects it.
  useEffect(() => {
    if (source && source.id === target?.id) setTargetChoice(NO_SUPPLIER_CHOICE);
  }, [source, target?.id]);

  const ready = Boolean(source && target && source.id !== target.id);

  /** "12 supplier parts and 3 purchase orders will move to X. Y will then be deleted." */
  const preview =
    source && target
      ? t('suppliers.merge.preview', {
          vars: {
            parts: t('suppliers.merge.parts', {
              vars: { count: source.partCount, n: source.partCount },
            }),
            orders: t('suppliers.merge.orders', {
              vars: { count: source.orderCount, n: source.orderCount },
            }),
            target: target.name,
            source: source.name,
          },
        })
      : null;

  const doMerge = () => {
    if (!source || !target) return;
    setError(null);
    merge.mutate(
      { sourceId: source.id, targetId: target.id },
      {
        onSuccess: () => {
          onAnnounce(t('suppliers.merge.done', { vars: { source: source.name, target: target.name } }));
          onClose();
        },
        onError: (e) => setError(describeError(e, t('suppliers.merge.error'))),
      },
    );
  };

  return (
    <Modal
      open
      onClose={onClose}
      title={t('suppliers.merge.title')}
      description={t('suppliers.merge.description')}
      busy={merge.isPending}
    >
      <div className="space-y-5">
        <SupplierSearchField
          label={t('suppliers.merge.source')}
          hint={t('suppliers.merge.source.hint')}
          value={sourceChoice}
          onChange={setSourceChoice}
          placeholder={t('suppliers.merge.choose')}
          data-testid="merge-source"
        />

        {/* A supplier can never be merged into itself, so it is simply not offered as its own
            target. Picking it as the *source* instead is handled above, by clearing the target. */}
        <SupplierSearchField
          label={t('suppliers.merge.target')}
          hint={t('suppliers.merge.target.hint')}
          value={targetChoice}
          onChange={setTargetChoice}
          excludeId={source?.id}
          placeholder={t('suppliers.merge.choose')}
          disabled={source === null}
          data-testid="merge-target"
        />

        {ready && preview ? (
          <Surface className="space-y-field-gap-compact p-4" data-testid="merge-preview">
            <p className="text-sm text-foreground">{preview}</p>
            <p className="flex items-start gap-2 text-xs text-muted-foreground">
              <WarningIcon aria-hidden className="mt-0.5 size-4 shrink-0 text-glyph-danger" />
              {t('suppliers.merge.irreversible')}
            </p>
          </Surface>
        ) : (
          <p className="text-sm text-muted-foreground">{t('suppliers.merge.pickBoth')}</p>
        )}

        {error ? (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        ) : null}

        <div className="flex flex-wrap items-center justify-end gap-2 border-t border-border pt-4">
          <Button variant="ghost" onClick={onClose} disabled={merge.isPending}>
            {t('suppliers.merge.cancel')}
          </Button>
          {confirming ? (
            <Button
              variant="destructive"
              onClick={doMerge}
              disabled={!ready || merge.isPending}
              data-testid="merge-confirm"
            >
              <MergeIcon aria-hidden />
              {t('suppliers.merge.confirm')}
            </Button>
          ) : (
            <Button
              onClick={() => setConfirming(true)}
              disabled={!ready || merge.isPending}
              data-testid="merge-start"
            >
              <MergeIcon aria-hidden />
              {t('suppliers.merge.action')}
            </Button>
          )}
        </div>
      </div>
    </Modal>
  );
}
