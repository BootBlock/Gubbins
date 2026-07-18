import { useRef, useState, type KeyboardEvent } from 'react';
import { Banner, Button, FormField, Input, Modal } from '@/components/foundry';
import { ScaleIcon, WarningIcon } from '@/components/icons';
import type { Item } from '@/db/repositories';
import { useT } from '@/features/i18n';
import { useFormatters } from '@/lib/useFormatters';
import { toGrams } from '@/lib/weight';
import { usePreferencesStore } from '@/state/stores/usePreferencesStore';
import { resolveWeighCount, weighCountNote } from '../weigh-count';
import { useAdjustQuantity } from '../mutations';

/**
 * "Count by weight" dialog (issue #101) — counts a handful of small, identical parts by
 * weighing them instead of counting them by hand. The user reads a gross weight off any
 * scale, optionally gives the tare of the tray it's in, and the item's recorded per-unit
 * mass turns that into a quantity.
 *
 * Two things keep this honest rather than merely convenient:
 *
 * - **The arithmetic and validation are a pure seam** ({@link resolveWeighCount}) and, like the gauge dialog,
 *   the result is converted to a *relative delta* here in the React layer, so only the delta
 *   reaches the database and the Activity Log — the CRDT integrity rule.
 * - **A scale reading is never exact.** The seam reports how far the reading sits from a
 *   whole number of units and this dialog surfaces that band verbatim: an ambiguous reading
 *   is called out as a warning rather than presented as a settled count, because a silently
 *   rounded quantity is worse than no count at all.
 *
 * Weights are entered and shown in the user's `weightUnit` preference and converted to
 * canonical grams at this edge — the seam only ever sees grams.
 */
export function WeighCountDialog({
  item,
  open,
  onClose,
}: {
  item: Item;
  open: boolean;
  onClose: () => void;
}) {
  const t = useT();
  const fmt = useFormatters();
  const adjust = useAdjustQuantity();
  const weightUnit = usePreferencesStore((s) => s.weightUnit);
  const [gross, setGross] = useState('');
  const [tare, setTare] = useState('');
  const grossRef = useRef<HTMLInputElement>(null);
  const tareRef = useRef<HTMLInputElement>(null);

  const unitWeight = item.weight;
  // Without a per-unit mass there is nothing to divide by, so the dialog degrades to an
  // explanation of what to record rather than an unusable form.
  const hasUnitWeight = unitWeight !== null && Number.isFinite(unitWeight) && unitWeight > 0;

  /**
   * Resolve a pair of entered weights. Takes the raw text rather than reading state so the
   * Enter handler can pass the *live DOM values*: the calculator-enabled field rewrites itself
   * on Enter (`40+3` → `43`) and only then calls our `onKeyDown`, so React state is still one
   * step behind at that moment. Reading state there would submit `Number.parseFloat('40+3')`
   * — a silently truncated `40` — and write the wrong quantity.
   */
  const resolve = (grossText: string, tareText: string) => {
    const grossGrams = toGrams(Number.parseFloat(grossText), weightUnit);
    const tareGrams = tareText.trim() === '' ? 0 : toGrams(Number.parseFloat(tareText), weightUnit);
    return {
      grossGrams,
      tareGrams,
      ...resolveWeighCount({
        grossGrams,
        tareGrams,
        unitWeightGrams: hasUnitWeight ? unitWeight : 0,
        quantity: item.quantity,
        grossBlank: grossText.trim() === '',
      }),
    };
  };

  const { result, issue, delta } = resolve(gross, tare);

  const submit = (grossText = gross, tareText = tare) => {
    const live = resolve(grossText, tareText);
    if (!live.result || live.issue || live.delta === 0) return;
    adjust.mutate(
      {
        id: item.id,
        delta: live.delta,
        note: weighCountNote({
          grossGrams: live.grossGrams,
          tareGrams: live.tareGrams,
          count: live.result.count,
          delta: live.delta,
          formatWeight: (grams) => fmt.weight(grams),
        }),
      },
      {
        onSuccess: () => {
          setGross('');
          setTare('');
          onClose();
        },
      },
    );
  };

  /** Enter submits using the field values as they stand in the DOM — see {@link resolve}. */
  const onEnter = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key !== 'Enter') return;
    submit(grossRef.current?.value ?? gross, tareRef.current?.value ?? tare);
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t('inventory.weighCount.title', { vars: { name: item.name } })}
      description={t('inventory.weighCount.description')}
      initialFocusRef={grossRef}
    >
      {!hasUnitWeight ? (
        <Banner
          tone="warning"
          icon={<WarningIcon aria-hidden />}
          heading={t('inventory.weighCount.noUnitWeight')}
        >
          {t('inventory.weighCount.noUnitWeightHelp')}
        </Banner>
      ) : (
        <>
          <p className="mb-4 text-sm text-muted-foreground">
            {t('inventory.weighCount.reference', {
              vars: { unitWeight: fmt.weight(unitWeight), quantity: item.quantity },
            })}
          </p>

          <div className="grid gap-4 sm:grid-cols-2">
            {/* `min`/`step` are deliberately omitted: a `type="number"` Input renders the
                calculator-backed NumberInput, which is a `type="text"` box — those attributes
                would be inert there, implying a constraint that is not enforced. Range is
                validated in the `resolveWeighCount` seam instead, which can also say *which*
                field is wrong. */}
            <FormField
              label={t('inventory.weighCount.grossLabel', { vars: { unit: weightUnit } })}
              hint={t('inventory.weighCount.grossHint')}
              error={
                issue === 'gross-negative'
                  ? t('inventory.weighCount.grossNegative')
                  : issue === 'unreadable'
                    ? t('inventory.weighCount.unreadable')
                    : undefined
              }
            >
              <Input
                ref={grossRef}
                type="number"
                value={gross}
                onChange={(e) => setGross(e.target.value)}
                onKeyDown={onEnter}
                placeholder="0"
              />
            </FormField>

            <FormField
              label={t('inventory.weighCount.tareLabel', { vars: { unit: weightUnit } })}
              hint={t('inventory.weighCount.tareHint')}
              error={
                issue === 'tare-too-heavy'
                  ? t('inventory.weighCount.tareTooHeavy')
                  : issue === 'tare-negative'
                    ? t('inventory.weighCount.tareNegative')
                    : undefined
              }
            >
              <Input
                ref={tareRef}
                type="number"
                value={tare}
                onChange={(e) => setTare(e.target.value)}
                onKeyDown={onEnter}
                placeholder="0"
              />
            </FormField>
          </div>

          {result ? (
            <div className="mt-4 rounded-xl border border-border bg-secondary/30 p-4">
              <p className="text-sm text-muted-foreground">
                {t('inventory.weighCount.netWeight', { vars: { weight: fmt.weight(result.netGrams) } })}
              </p>
              <p className="mt-1 text-2xl font-semibold" data-testid="weigh-count-result">
                {t('inventory.weighCount.count', { vars: { count: result.count } })}
              </p>
              <p className="mt-1 text-sm text-muted-foreground">
                {delta === 0
                  ? t('inventory.weighCount.noChange')
                  : t('inventory.weighCount.delta', {
                      vars: { delta: `${delta > 0 ? '+' : ''}${delta}`, quantity: item.quantity },
                    })}
              </p>
            </div>
          ) : null}

          {/* The confidence band is the whole point of the seam: only an `exact` reading is
              allowed to pass without comment. `close` explains the drift, `uncertain` warns
              that the count is a guess — but neither blocks the user, who may well know the
              scale is imprecise and want the number anyway. */}
          {result && result.confidence !== 'exact' ? (
            <Banner
              tone={result.confidence === 'uncertain' ? 'warning' : 'info'}
              className="mt-3"
              icon={<WarningIcon aria-hidden />}
              data-testid={`weigh-count-confidence-${result.confidence}`}
            >
              {result.confidence === 'uncertain'
                ? t('inventory.weighCount.uncertain')
                : t('inventory.weighCount.close')}
            </Banner>
          ) : null}
        </>
      )}

      <div className="mt-6 flex justify-end gap-2">
        <Button variant="ghost" onClick={onClose}>
          {t('inventory.weighCount.cancel')}
        </Button>
        {hasUnitWeight ? (
          <Button
            data-testid="weigh-count-apply"
            // Wrapped, not passed by reference: `submit` takes optional text overrides, and a
            // bare handler would hand it the click event as the gross reading.
            onClick={() => submit()}
            disabled={!result || issue !== null || delta === 0 || adjust.isPending}
          >
            <ScaleIcon aria-hidden />
            {t('inventory.weighCount.apply')}
          </Button>
        ) : null}
      </div>
    </Modal>
  );
}
