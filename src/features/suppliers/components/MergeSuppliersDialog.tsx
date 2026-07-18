import { useEffect, useMemo, useState } from 'react';
import { Button, FormField, Modal, Select, Surface } from '@/components/foundry';
import { MergeIcon, WarningIcon } from '@/components/icons';
import type { SupplierWithCounts } from '@/db/repositories';
import { useT } from '@/features/i18n';
import { useMergeSuppliers } from '../mutations';

export interface MergeSuppliersDialogProps {
  readonly suppliers: readonly SupplierWithCounts[];
  /** Pre-selected source (the supplier the user was looking at), if any. */
  readonly initialSourceId?: string;
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
 */
export function MergeSuppliersDialog({
  suppliers,
  initialSourceId,
  onClose,
  onAnnounce,
}: MergeSuppliersDialogProps) {
  const t = useT();
  const merge = useMergeSuppliers();

  const [sourceId, setSourceId] = useState(initialSourceId ?? '');
  const [targetId, setTargetId] = useState('');
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const source = suppliers.find((s) => s.id === sourceId);
  const target = suppliers.find((s) => s.id === targetId);

  // A supplier can never be merged into itself, so it is simply not offered as its own target.
  const sourceOptions = useMemo(() => suppliers.map((s) => ({ value: s.id, label: s.name })), [suppliers]);
  const targetOptions = useMemo(
    () => suppliers.filter((s) => s.id !== sourceId).map((s) => ({ value: s.id, label: s.name })),
    [suppliers, sourceId],
  );

  // Changing either side invalidates a confirm the user already gave — they would otherwise be
  // one click from merging a pair they never read the preview for.
  useEffect(() => {
    setConfirming(false);
  }, [sourceId, targetId]);

  // Picking the current target as the source would leave the two equal; drop the stale target.
  useEffect(() => {
    if (sourceId.length > 0 && sourceId === targetId) setTargetId('');
  }, [sourceId, targetId]);

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
        onError: (e) => setError(e instanceof Error ? e.message : t('suppliers.merge.error')),
      },
    );
  };

  return (
    <Modal
      open
      onClose={onClose}
      title={t('suppliers.merge.title')}
      description={t('suppliers.merge.description')}
    >
      <div className="space-y-5">
        <FormField label={t('suppliers.merge.source')} hint={t('suppliers.merge.source.hint')}>
          <Select
            value={sourceId}
            onChange={setSourceId}
            options={sourceOptions}
            placeholder={t('suppliers.merge.choose')}
            data-testid="merge-source"
          />
        </FormField>

        <FormField label={t('suppliers.merge.target')} hint={t('suppliers.merge.target.hint')}>
          <Select
            value={targetId}
            onChange={setTargetId}
            options={targetOptions}
            placeholder={t('suppliers.merge.choose')}
            disabled={sourceId.length === 0}
            data-testid="merge-target"
          />
        </FormField>

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
            <Button variant="destructive" onClick={doMerge} disabled={!ready || merge.isPending}>
              <MergeIcon aria-hidden />
              {t('suppliers.merge.confirm')}
            </Button>
          ) : (
            <Button onClick={() => setConfirming(true)} disabled={!ready || merge.isPending}>
              <MergeIcon aria-hidden />
              {t('suppliers.merge.action')}
            </Button>
          )}
        </div>
      </div>
    </Modal>
  );
}
