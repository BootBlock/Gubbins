/**
 * The before/after values one Activity Log entry recorded (issue #486).
 *
 * An edit writes each changed field's old and new value into the entry's metadata, and a sync
 * merge records the same shape for what it overwrote. Until this component the row showed only
 * the note — "Changed unit cost, barcode." — so the values were in the ledger but invisible,
 * which is most of what makes an audit trail useful in the app rather than only to a machine
 * reading the database.
 *
 * It renders as a definition list, one field per line: the label, the value before, the value
 * after. Both surfaces that show a ledger entry mount it (the item's Activity tab and the global
 * feed), so the two can never disagree about how a recorded value reads.
 *
 * **Height.** Both surfaces virtualise their rows with an *estimated* size and re-measure the real
 * one through `virtualizer.measureElement`, so an entry that names four fields is measured at four
 * lines rather than clipped to the estimate. Each value truncates on its own line, so a long
 * serial number widens nothing.
 */
import { Fragment } from 'react';
import { Money } from '@/components/foundry';
import { useT } from '@/features/i18n';
import { cn } from '@/lib/utils';
import { useFormatters } from '@/lib/useFormatters';
import { auditedItemField } from '../audited-item-fields';
import { useCategoryNames } from '../categories';
import { describeChange, type ChangeValueView } from '../history-change-format';
import type { HistoryFieldChange } from '../history-format';

export function HistoryChangeList({ changes }: { changes: readonly HistoryFieldChange[] }) {
  const t = useT();
  const formatters = useFormatters();
  const categoryNames = useCategoryNames();

  const rows = changes.map((change) =>
    describeChange(
      change,
      {
        formatters,
        categoryName: (id) => categoryNames.get(id) ?? null,
        notSet: t('inventory.activityLog.change.notSet'),
        unknownCategory: t('inventory.activityLog.change.unknownCategory'),
      },
      // A field this build does not know keeps its raw camelCase name: a newer peer's entry is
      // still a true record, and naming it badly beats dropping it from the audit trail.
      (field) => {
        const known = auditedItemField(field);
        return known ? t(known.labelKey) : field;
      },
    ),
  );

  return (
    <dl
      data-testid="activity-log-changes"
      className="mt-1 grid grid-cols-[minmax(0,auto)_minmax(0,1fr)] gap-x-2 text-xs"
    >
      {rows.map((row) => (
        <Fragment key={row.field}>
          <dt className="truncate text-muted-foreground">{row.label}</dt>
          <dd className="flex min-w-0 items-baseline gap-1">
            <ChangeValue view={row.from} className="truncate text-muted-foreground" />
            {/* The arrow is decoration; assistive tech reads the relation from the words instead,
                so "Unit cost £4.00 £5.50" cannot be mistaken for two unrelated figures. */}
            <span aria-hidden="true" className="shrink-0 text-muted-foreground/70">
              →
            </span>
            <span className="sr-only">{t('inventory.activityLog.change.to')}</span>
            <ChangeValue view={row.to} className="truncate text-foreground" />
          </dd>
        </Fragment>
      ))}
    </dl>
  );
}

/** One side of a change — a price through the Foundry `Money` primitive, anything else as text. */
function ChangeValue({ view, className }: { view: ChangeValueView; className?: string }) {
  return view.kind === 'money' ? (
    <Money value={view.value} className={cn('min-w-0', className)} />
  ) : (
    <span className={cn('min-w-0', className)}>{view.text}</span>
  );
}
