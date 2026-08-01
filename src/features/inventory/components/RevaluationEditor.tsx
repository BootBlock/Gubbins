/**
 * RevaluationEditor — the manual current / market value surface for one item (feature-gap G9).
 *
 * Straight-line depreciation (the AssetEditor above) only ever *lowers* an asset's book value.
 * Collectibles, tools and property appreciate, and an insurance schedule needs *today's* worth.
 * This editor records a manual current value that can move up or down independently of the
 * depreciation curve, keeps an append-only log of those revaluations, and shows the trend.
 *
 * All maths lives in the pure `valuation.ts` seam (`buildRevaluationSeries` / `describeValueChange`);
 * the sparkline reuses `sparklinePolyline` from `price-history.ts`. Design tokens only (trend tone
 * via `text-*` tokens driving `currentColor`); `<Money>` renders every figure.
 */
import { useEffect, useState } from 'react';
import { Button, FormField, InfoHint, Input, Money, MoneyInput } from '@/components/foundry';
import { CostIcon } from '@/components/icons';
import type { Item } from '@/db/repositories';
import { useT } from '@/features/i18n';
import { cn } from '@/lib/utils';
import { useFormatters } from '@/lib/useFormatters';
import { useItemRevaluations } from '../queries';
import { useRecordRevaluation, useUpdateItem } from '../mutations';
import { buildRevaluationSeries, describeValueChange, type ValueDirection } from '../valuation';
import { sparklinePolyline } from '../price-history';
import { measureIssueText, parseOptionalNumber } from './measure-draft';
import { fromDateInputValue, toDateInputValue } from './inventory-ui';

const SPARK_WIDTH = 140;
const SPARK_HEIGHT = 28;

/** How many recent revaluation points to list under the trend. */
const RECENT_LIMIT = 5;

/** A rising value is a gain, a falling one a loss; flat/none is neutral — token colours only. */
const DIRECTION_TONE: Record<ValueDirection, string> = {
  up: 'text-success',
  down: 'text-warning',
  flat: 'text-muted-foreground',
  none: 'text-muted-foreground',
};

const DIRECTION_GLYPH: Record<ValueDirection, string> = {
  up: '↑',
  down: '↓',
  flat: '→',
  none: '',
};

export function RevaluationEditor({ item }: { item: Item }) {
  const t = useT();
  const fmt = useFormatters();
  const record = useRecordRevaluation();
  const update = useUpdateItem();
  const { data: revaluations } = useItemRevaluations(item.id);

  const [amount, setAmount] = useState('');
  const [date, setDate] = useState('');
  const [note, setNote] = useState('');

  // Clear the draft whenever the persisted value changes (a save, or switching item).
  useEffect(() => {
    setAmount('');
    setDate('');
    setNote('');
  }, [item.id, item.currentValue]);

  const series = buildRevaluationSeries(revaluations ?? []);
  const tone = DIRECTION_TONE[series.direction];
  const recent = [...series.points].reverse().slice(0, RECENT_LIMIT);

  // Trend of the live value against the original purchase price, when both are known.
  const vsPurchase =
    item.currentValue != null && item.purchasePrice != null && item.purchasePrice > 0
      ? describeValueChange(item.purchasePrice, item.currentValue)
      : null;

  // A revaluation is a figure to *record*, so a blank field simply isn't ready yet (no error);
  // an entry that can't be used says why rather than leaving the button inexplicably dead — the
  // same reporting seam the asset fields above parse through (issue #675).
  const amountEntry = parseOptionalNumber(amount);
  const nextAmount = amountEntry.issue === null ? amountEntry.value : null;
  const canSave = nextAmount !== null && !record.isPending;

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (nextAmount === null) return;
    const revaluedAt = fromDateInputValue(date);
    record.mutate({
      id: item.id,
      input: {
        value: nextAmount,
        revaluedAt: revaluedAt ?? undefined,
        note: note.trim() || null,
      },
    });
  };

  const clear = () => update.mutate({ id: item.id, input: { currentValue: null } });

  return (
    <section className="space-y-3 border-t border-border pt-4" aria-label="Current value & revaluations">
      <div className="flex items-center justify-between gap-2">
        <h4 className="flex items-center gap-1.5 text-sm font-medium text-foreground">
          Current value
          <InfoHint
            content={
              'An optional manual **current / market value** per unit — for assets that ' +
              '**appreciate** (collectibles, tools, property) rather than depreciate. When set it ' +
              'wins over the depreciated book value in the insurance schedule and valuation reports. ' +
              'Each change is kept in an append-only revaluation log below.'
            }
          />
        </h4>
        {item.currentValue != null ? (
          <Button
            variant="ghost"
            size="sm"
            onClick={clear}
            disabled={update.isPending}
            data-testid="clear-current-value"
          >
            Clear
          </Button>
        ) : null}
      </div>

      {/* The live current value + its trend against purchase price. */}
      {item.currentValue != null ? (
        <p
          className="flex flex-wrap items-center gap-1.5 text-sm font-medium text-foreground [&_svg]:size-4"
          aria-live="polite"
        >
          <CostIcon />
          <Money value={item.currentValue} formatters={fmt} />
          {vsPurchase && vsPurchase.abs !== 0 ? (
            <span
              className={cn('inline-flex items-center gap-0.5 text-xs', DIRECTION_TONE[vsPurchase.direction])}
            >
              <span aria-hidden>{DIRECTION_GLYPH[vsPurchase.direction]}</span>
              {vsPurchase.abs > 0 ? '+' : '−'}
              <Money value={Math.abs(vsPurchase.abs)} formatters={fmt} />
              {vsPurchase.pct !== null ? (
                <span>
                  {' '}
                  ({vsPurchase.pct > 0 ? '+' : '−'}
                  {Math.abs(Math.round(vsPurchase.pct))}%)
                </span>
              ) : null}
              <span className="text-muted-foreground"> vs purchase</span>
            </span>
          ) : null}
        </p>
      ) : (
        <p className="text-xs text-muted-foreground">
          No manual value set — the asset is valued at its depreciated replacement cost.
        </p>
      )}

      {/* Sparkline over the recorded points (only when there is a trend to draw). */}
      {series.count >= 2 ? (
        <svg
          viewBox={`0 0 ${SPARK_WIDTH} ${SPARK_HEIGHT}`}
          width={SPARK_WIDTH}
          height={SPARK_HEIGHT}
          className={tone}
          role="img"
          aria-label={`Value trend over ${series.count} recorded revaluations`}
          preserveAspectRatio="none"
        >
          <polyline
            points={sparklinePolyline(
              series.points.map((p) => p.value),
              SPARK_WIDTH,
              SPARK_HEIGHT,
            )}
            fill="none"
            stroke="currentColor"
            strokeWidth={1.5}
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      ) : null}

      {/* Record a new revaluation. */}
      <form onSubmit={submit} className="grid grid-cols-2 gap-3">
        <FormField
          compact
          label="New value"
          error={measureIssueText(amountEntry.issue, t)}
          hint={
            'The item’s current worth **per unit** in the base currency. Recording it sets the ' +
            'current value and appends a point to the revaluation log.\n\nEnter it as plain ' +
            'digits — `1250`, not `1,250` — with a full stop for any decimals.'
          }
        >
          <MoneyInput
            value={amount}
            onValueChange={setAmount}
            placeholder="—"
            data-testid="revaluation-amount"
          />
        </FormField>

        <FormField
          compact
          label="As of"
          hint={'The date this valuation applies from. Defaults to today when left blank.'}
        >
          <Input
            type="date"
            value={date}
            onChange={(e) => setDate(e.target.value)}
            data-testid="revaluation-date"
          />
        </FormField>

        <div className="col-span-2">
          <FormField compact label="Note (optional)">
            <Input
              type="text"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="e.g. post-restoration appraisal"
              data-testid="revaluation-note"
            />
          </FormField>
        </div>

        <div className="col-span-2 flex justify-end">
          <Button type="submit" size="sm" disabled={!canSave} data-testid="record-revaluation">
            Record revaluation
          </Button>
        </div>
      </form>

      {/* Revaluation history, newest first. */}
      {recent.length > 0 ? (
        <div>
          <p className="mb-field-gap-compact text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Revaluation history
          </p>
          <ul className="flex flex-col gap-0.5" data-testid="revaluation-history">
            {recent.map((p) => (
              <li
                key={p.id}
                className="flex items-center justify-between gap-2 text-xs text-muted-foreground"
              >
                <Money value={p.value} formatters={fmt} className="text-foreground" />
                <span className="flex items-center gap-2">
                  {p.note ? <span className="truncate">{p.note}</span> : null}
                  <time dateTime={toDateInputValue(p.revaluedAt)}>{fmt.calendarDate(p.revaluedAt)}</time>
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </section>
  );
}
