/**
 * Lookup review & opt-in dialog (issue #616, phase L1) — the §4 no-overwrite safeguard, worn
 * where the user can see it.
 *
 * The dynamic-target sibling of `ScrapeReviewDialog`: empty fields fill automatically (`FILL`),
 * already-populated differing fields are surfaced as opt-in tick boxes (`CONFLICT`) defaulting to
 * **off**, so nothing the user typed is ever clobbered without an explicit tick.
 *
 * Two things this shows that the scrape dialog has no need to:
 *
 * - **What could not be applied, and why.** A key bound to no field, bound to a field of the wrong
 *   type, or carrying a value that field cannot hold is listed rather than silently dropped
 *   (the #350 rule). A user whose category has no "Director" field should be told that, not left
 *   wondering why the director never appeared.
 * - **Where the values came from.** The source is named, because a user should never be left
 *   guessing where a value on their item originated — and for a film that source is emphatically
 *   *not* IMDb, even though the IMDb link is among the values.
 */
import { useEffect, useState } from 'react';
import { Button, Checkbox, InfoHint, Modal } from '@/components/foundry';
import { InfoIcon, WarningIcon } from '@/components/icons';
import { useT, type TypedTranslator } from '@/features/i18n';
import { assertExhaustive } from '@/lib/exhaustive';
import type { FieldType } from '@/db/repositories';
import type { MessageKey } from '@/features/i18n';
import {
  applyLookupFillPlan,
  planHasChanges,
  type LookupFillPlan,
  type LookupFillProblem,
  type LookupFillWrite,
} from '../fill-plan';
import { isBuiltinLookupTarget, type BuiltinLookupTarget } from '../types';

/**
 * The translated name of each field type, for the "wrong kind of field" line.
 *
 * `FIELD_TYPE_LABELS` (`inventory-ui.ts`) is the app's English-only registry, and splicing it into
 * an otherwise-translated sentence would leave a German reader reading "…ist ein Feld des Typs
 * Long text". Typed as a total `Record<FieldType, …>`, so adding a field type is a compile error
 * here rather than a silently missing word.
 */
const FIELD_TYPE_MESSAGE: Record<FieldType, MessageKey> = {
  TEXT: 'lookup.fieldType.text',
  LONG_TEXT: 'lookup.fieldType.longText',
  URL: 'lookup.fieldType.url',
  NUMBER: 'lookup.fieldType.number',
  RATING: 'lookup.fieldType.rating',
  BOOLEAN: 'lookup.fieldType.boolean',
  ON_OFF: 'lookup.fieldType.onOff',
  DATE: 'lookup.fieldType.date',
  SELECT: 'lookup.fieldType.select',
  FILE: 'lookup.fieldType.file',
  IMAGE: 'lookup.fieldType.image',
};

/** The translated name of a reserved built-in target, for a row that fills one. */
function builtinLabel(t: TypedTranslator, target: BuiltinLookupTarget): string {
  return target === 'builtin:name' ? t('lookup.builtin.name') : t('lookup.builtin.description');
}

/**
 * The display name of a target: the user's own field name, or the built-in's translated label.
 *
 * A binding to a custom field is named by *that field*, so the row reads in the user's own
 * vocabulary rather than in the provider's.
 */
function targetLabel(t: TypedTranslator, name: string): string {
  return isBuiltinLookupTarget(name) ? builtinLabel(t, name) : name;
}

/** One "couldn't be applied" line, phrased for the specific reason. */
function problemText(t: TypedTranslator, problem: LookupFillProblem): string {
  switch (problem.kind) {
    case 'NO_FIELD':
      return t('lookup.review.problem.noField', { vars: { name: targetLabel(t, problem.wantedName) } });
    case 'TYPE_MISMATCH':
      return t('lookup.review.problem.typeMismatch', {
        vars: {
          name: targetLabel(t, problem.wantedName),
          found: t(FIELD_TYPE_MESSAGE[problem.foundType]),
          wanted: t(FIELD_TYPE_MESSAGE[problem.wantedType]),
        },
      });
    case 'UNUSABLE_VALUE':
      return t('lookup.review.problem.unusableValue', {
        vars: { name: targetLabel(t, problem.wantedName), reason: problem.reason },
      });
    default:
      assertExhaustive(problem);
      // An unrecognised problem shape still gets a line, rather than vanishing from the list —
      // "reported, never silently dropped" is the whole point of this section.
      return t('lookup.review.problem.unknown');
  }
}

/** An em dash for an empty value, so a blank row is never an invisible one. */
function display(value: string | null): string {
  return value === null || value.trim().length === 0 ? '—' : value;
}

export function LookupReviewDialog({
  open,
  plan,
  sourceName,
  sourceUrl,
  onApply,
  onClose,
  isApplying = false,
}: {
  open: boolean;
  plan: LookupFillPlan;
  sourceName: string;
  sourceUrl: string;
  onApply: (write: LookupFillWrite) => void;
  onClose: () => void;
  isApplying?: boolean;
}) {
  const t = useT();
  const [overwrites, setOverwrites] = useState<ReadonlySet<string>>(new Set());

  // A fresh plan starts with every overwrite off again — a tick carried over from a previous
  // lookup would silently authorise an overwrite the user never saw.
  useEffect(() => {
    if (open) setOverwrites(new Set());
  }, [open, plan]);

  const fills = plan.proposals.filter((proposal) => proposal.status === 'FILL');
  const conflicts = plan.proposals.filter((proposal) => proposal.status === 'CONFLICT');
  const canApply = planHasChanges(plan, overwrites);

  const toggle = (outputKey: string) =>
    setOverwrites((current) => {
      const next = new Set(current);
      if (next.has(outputKey)) next.delete(outputKey);
      else next.add(outputKey);
      return next;
    });

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t('lookup.review.title', { vars: { source: sourceName } })}
      description={t('lookup.review.description')}
      className="max-w-lg"
      busy={isApplying}
    >
      <div className="space-y-4">
        {fills.length === 0 && conflicts.length === 0 ? (
          <p className="flex items-center gap-2 text-sm text-muted-foreground [&_svg]:size-4">
            <InfoIcon aria-hidden />
            {t('lookup.review.nothing', { vars: { source: sourceName } })}
          </p>
        ) : null}

        {fills.length > 0 ? (
          <section>
            <h4 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              {t('lookup.review.fills')}
            </h4>
            <ul className="space-y-1 text-sm">
              {fills.map((proposal) => (
                <li key={proposal.outputKey} className="flex justify-between gap-3">
                  <span className="text-muted-foreground">{targetLabel(t, proposal.targetName)}</span>
                  <span className="min-w-0 break-words text-right font-medium">
                    {display(proposal.incoming)}
                  </span>
                </li>
              ))}
            </ul>
          </section>
        ) : null}

        {conflicts.length > 0 ? (
          <section>
            <h4 className="mb-1.5 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-warning [&_svg]:size-3.5">
              <WarningIcon aria-hidden />
              {t('lookup.review.conflicts')}
              <InfoHint content={t('lookup.review.conflictsHint')} className="ml-0.5" />
            </h4>
            <ul className="space-y-2 text-sm">
              {conflicts.map((proposal) => (
                <li key={proposal.outputKey} className="rounded-lg border border-border p-2">
                  {/* eslint-disable-next-line jsx-a11y/label-has-associated-control -- the nested checkbox is correctly associated; the label's text is the dynamic field name, which the linter cannot resolve to a static string. */}
                  <label className="flex items-start gap-2">
                    <Checkbox
                      checked={overwrites.has(proposal.outputKey)}
                      onChange={() => toggle(proposal.outputKey)}
                      className="mt-1"
                      data-testid={`lookup-overwrite-${proposal.outputKey}`}
                    />
                    <span className="min-w-0 flex-1">
                      <span className="font-medium">{targetLabel(t, proposal.targetName)}</span>
                      <span className="mt-0.5 block break-words text-xs text-muted-foreground">
                        {t('lookup.review.yours')}{' '}
                        <span className="text-foreground">{display(proposal.current)}</span> → {sourceName}:{' '}
                        <span className="text-foreground">{display(proposal.incoming)}</span>
                      </span>
                    </span>
                  </label>
                </li>
              ))}
            </ul>
          </section>
        ) : null}

        {plan.problems.length > 0 ? (
          <section>
            <h4 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              {t('lookup.review.problems')}
            </h4>
            <ul className="space-y-1 text-xs text-muted-foreground">
              {plan.problems.map((problem) => (
                <li key={`${problem.kind}-${problem.outputKey}`}>{problemText(t, problem)}</li>
              ))}
            </ul>
          </section>
        ) : null}

        <p className="text-xs text-muted-foreground">
          {t('lookup.review.provenance', { vars: { source: sourceName } })}{' '}
          <a
            href={sourceUrl}
            target="_blank"
            rel="noreferrer noopener"
            className="underline decoration-dotted underline-offset-2 hover:text-foreground"
          >
            {sourceUrl}
          </a>
        </p>

        <div className="flex justify-end gap-2 pt-1">
          <Button type="button" variant="ghost" onClick={onClose} disabled={isApplying}>
            {t('lookup.cancel')}
          </Button>
          <Button
            type="button"
            onClick={() => onApply(applyLookupFillPlan(plan, overwrites))}
            disabled={isApplying || !canApply}
            data-testid="lookup-review-apply"
          >
            {isApplying ? t('lookup.review.applying') : t('lookup.review.apply')}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
