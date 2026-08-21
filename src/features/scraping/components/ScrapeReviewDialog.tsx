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
import { Banner, Button, Checkbox, Modal, Money, Tooltip, INFO_OPEN_DELAY_MS } from '@/components/foundry';
import { InfoIcon, WarningIcon } from '@/components/icons';
import { useT } from '@/features/i18n';
import { normaliseCurrencyCode } from '@/lib/money';
import { useFormatters } from '@/lib/useFormatters';
import { usePreferencesStore } from '@/state/stores/usePreferencesStore';
import { applyScrapeMerge, buildScrapeMergePlan, type ScrapeField, type ScrapeWrite } from '../merge';
import type { ExistingItemFields, FieldProposal, ScrapeMergePlan } from '../merge';
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

/**
 * Render one proposed value. A unit cost is money, so it goes through the Foundry `Money`
 * primitive under the currency it was actually quoted in — a bare `4.15` beside a GBP base
 * currency reads as £4.15 when the supplier quoted $4.15, which is the ambiguity issue #666
 * is about. Every other field is plain text.
 */
function ProposedValue({ proposal, currency }: { proposal: FieldProposal; currency: string | null }) {
  if (proposal.field === 'unitCost' && typeof proposal.scraped === 'number') {
    return <Money value={proposal.scraped} currency={currency ?? undefined} />;
  }
  return <>{display(proposal.scraped)}</>;
}

/**
 * Render the user's current value for a conflicting field. An item's own unit cost carries no
 * currency of its own, so it is always the base currency — shown as such, so the two sides of
 * a "Yours → Supplier" comparison are never two differently-denominated bare numbers.
 */
function CurrentValue({ proposal }: { proposal: FieldProposal }) {
  if (proposal.field === 'unitCost' && typeof proposal.current === 'number') {
    return <Money value={proposal.current} />;
  }
  return <>{display(proposal.current)}</>;
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
  const t = useT();
  const f = useFormatters();
  const baseCurrency = usePreferencesStore((s) => s.baseCurrency);
  const plan: ScrapeMergePlan = useMemo(
    () => buildScrapeMergePlan(existing, payload, baseCurrency),
    [existing, payload, baseCurrency],
  );
  const [overwrites, setOverwrites] = useState<ReadonlySet<ScrapeField>>(new Set());

  const fills = plan.proposals.filter((p) => p.status === 'FILL');
  const conflicts = plan.proposals.filter((p) => p.status === 'CONFLICT');
  // A price quoted in another currency (issue #666): shown, explained, and never applied to the
  // item's currency-less unit cost. It still reaches `supplier_parts`, which does record a code.
  const foreign = plan.proposals.find((p) => p.status === 'FOREIGN');
  // `FOREIGN` is only ever reached with a numeric price and an explicit code that differs from a
  // known base, so all three parts of the warning are present whenever the banner renders.
  const foreignPrice = typeof foreign?.scraped === 'number' ? foreign.scraped : null;
  // A withheld foreign price is still worth applying: the item's unit cost is left alone, but the
  // caller records the quote against the supplier part, which does carry its own currency column.
  const nothingToDo =
    fills.length === 0 && conflicts.length === 0 && plan.aliasAdditions.length === 0 && foreign === undefined;

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
      busy={isApplying}
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
                  <span className="font-medium">
                    <ProposedValue proposal={p} currency={plan.currency} />
                  </span>
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
                  {/* eslint-disable-next-line jsx-a11y/label-has-associated-control -- the nested checkbox is correctly associated; the label's text comes from the dynamic {p.field} content, which the linter cannot resolve to a static string. */}
                  <label className="flex items-start gap-2">
                    <Checkbox
                      checked={overwrites.has(p.field)}
                      onChange={() => toggle(p.field)}
                      className="mt-1"
                      data-testid={`overwrite-${p.field}`}
                    />
                    <span className="min-w-0 flex-1">
                      <span className="font-medium">{FIELD_LABELS[p.field]}</span>
                      <span className="mt-0.5 block text-xs text-muted-foreground">
                        Yours:{' '}
                        <span className="text-foreground">
                          <CurrentValue proposal={p} />
                        </span>{' '}
                        → Supplier:{' '}
                        <span className="text-foreground">
                          <ProposedValue proposal={p} currency={plan.currency} />
                        </span>
                      </span>
                    </span>
                  </label>
                </li>
              ))}
            </ul>
          </section>
        ) : null}

        {foreignPrice !== null ? (
          <Banner
            tone="warning"
            icon={<WarningIcon aria-hidden />}
            heading={t('scraping.review.foreignPrice.heading')}
            data-testid="scrape-review-foreign-price"
          >
            {t('scraping.review.foreignPrice.body', {
              vars: {
                price: f.currency(foreignPrice, plan.currency ?? undefined),
                quoted: normaliseCurrencyCode(plan.currency) ?? '',
                base: plan.baseCurrency ?? '',
              },
            })}
          </Banner>
        ) : null}

        {plan.aliasAdditions.length > 0 ? (
          <p className="text-xs text-muted-foreground">
            Will map supplier part number{plan.aliasAdditions.length > 1 ? 's' : ''}:{' '}
            <span className="text-foreground">{plan.aliasAdditions.join(', ')}</span>
          </p>
        ) : null}

        <div className="flex justify-end gap-2 pt-1">
          <Button type="button" variant="ghost" onClick={onClose} disabled={isApplying}>
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
