/**
 * Scrape review & opt-in dialog (spec §4 CRITICAL no-overwrite safeguard).
 *
 * Shows what a scrape proposes against an item's *current* fields: empty fields fill
 * automatically (`FILL`), already-populated differing fields are surfaced as opt-in
 * checkboxes (`CONFLICT`) defaulting to **off** so nothing the user typed is ever
 * clobbered without an explicit tick. On confirm it resolves the plan via the pure
 * {@link applyScrapeMerge} and hands the concrete write to `onApply`.
 */
import { useMemo, useState } from 'react';
import { Button, Modal, Tooltip, INFO_OPEN_DELAY_MS } from '@/components/foundry';
import { InfoIcon, WarningIcon } from '@/components/icons';
import { applyScrapeMerge, buildScrapeMergePlan, type ScrapeField, type ScrapeWrite } from '../merge';
import type { ExistingItemFields } from '../merge';
import type { ScrapeResultPayload } from '../protocol';

const FIELD_LABELS: Record<ScrapeField, string> = {
  mpn: 'MPN',
  manufacturer: 'Manufacturer',
  description: 'Description',
  unitCost: 'Unit cost',
};

function display(value: string | number | null): string {
  if (value === null) return '—';
  return String(value);
}

export function ScrapeReviewDialog({
  open,
  existing,
  payload,
  onApply,
  onClose,
  isApplying = false,
}: {
  open: boolean;
  existing: ExistingItemFields;
  payload: ScrapeResultPayload;
  onApply: (write: ScrapeWrite) => void;
  onClose: () => void;
  isApplying?: boolean;
}) {
  const plan = useMemo(() => buildScrapeMergePlan(existing, payload), [existing, payload]);
  const [overwrites, setOverwrites] = useState<ReadonlySet<ScrapeField>>(new Set());

  const fills = plan.proposals.filter((p) => p.status === 'FILL');
  const conflicts = plan.proposals.filter((p) => p.status === 'CONFLICT');
  const nothingToDo = fills.length === 0 && conflicts.length === 0 && plan.aliasAdditions.length === 0;

  const toggle = (field: ScrapeField) =>
    setOverwrites((current) => {
      const next = new Set(current);
      if (next.has(field)) next.delete(field);
      else next.add(field);
      return next;
    });

  const confirm = () => onApply(applyScrapeMerge(plan, overwrites));

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Review scraped data"
      description="Empty fields are filled automatically. Your existing values are never changed unless you tick them."
      className="max-w-lg"
    >
      <div className="space-y-4">
        {nothingToDo ? (
          <p className="flex items-center gap-2 text-sm text-muted-foreground [&_svg]:size-4">
            <InfoIcon />
            Nothing new to apply — your item already matches the supplier data.
          </p>
        ) : null}

        {fills.length > 0 ? (
          <section>
            <h4 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Will fill (currently empty)
            </h4>
            <ul className="space-y-1 text-sm">
              {fills.map((p) => (
                <li key={p.field} className="flex justify-between gap-3">
                  <span className="text-muted-foreground">{FIELD_LABELS[p.field]}</span>
                  <span className="font-medium">{display(p.scraped)}</span>
                </li>
              ))}
            </ul>
          </section>
        ) : null}

        {conflicts.length > 0 ? (
          <section>
            <h4 className="mb-1.5 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-warning [&_svg]:size-3.5">
              <WarningIcon />
              Overwrite your value? (off by default)
              <Tooltip
                content="These fields already hold a value you entered. Tick one only if you want the supplier's value to replace yours — anything left unticked is kept."
                openDelayMs={INFO_OPEN_DELAY_MS}
                className="ml-0.5 text-muted-foreground"
              >
                <InfoIcon aria-label="About overwrites" />
              </Tooltip>
            </h4>
            <ul className="space-y-2 text-sm">
              {conflicts.map((p) => (
                <li key={p.field} className="rounded-lg border border-border p-2">
                  <label className="flex items-start gap-2">
                    <input
                      type="checkbox"
                      checked={overwrites.has(p.field)}
                      onChange={() => toggle(p.field)}
                      className="mt-1"
                      data-testid={`overwrite-${p.field}`}
                    />
                    <span className="min-w-0 flex-1">
                      <span className="font-medium">{FIELD_LABELS[p.field]}</span>
                      <span className="mt-0.5 block text-xs text-muted-foreground">
                        Yours: <span className="text-foreground">{display(p.current)}</span> → Supplier:{' '}
                        <span className="text-foreground">{display(p.scraped)}</span>
                      </span>
                    </span>
                  </label>
                </li>
              ))}
            </ul>
          </section>
        ) : null}

        {plan.aliasAdditions.length > 0 ? (
          <p className="text-xs text-muted-foreground">
            Will map supplier part number{plan.aliasAdditions.length > 1 ? 's' : ''}:{' '}
            <span className="text-foreground">{plan.aliasAdditions.join(', ')}</span>
          </p>
        ) : null}

        <div className="flex justify-end gap-2 pt-1">
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="button" onClick={confirm} disabled={isApplying || nothingToDo}>
            {isApplying ? 'Applying…' : 'Apply'}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
