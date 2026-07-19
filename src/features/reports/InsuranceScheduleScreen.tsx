import { Button, Money, PageContainer, PageHeader, Spinner, MAIN_CONTENT_ID } from '@/components/foundry';
import { InsuranceScheduleIcon, PrintIcon } from '@/components/icons';
import { cn } from '@/lib/utils';
import { plural } from '@/lib/plural';
import type { Formatters } from '@/lib/format';
import { useFormatters } from '@/lib/useFormatters';
import { Thumbnail } from '@/features/inventory/components/Thumbnail';
import {
  CONDITION_COLOR_CLASS,
  CONDITION_LABELS,
  WARRANTY_STATUS_COLOR_CLASS,
  WARRANTY_STATUS_LABEL,
} from '@/features/inventory/components/inventory-ui';
import { useInsuranceSchedule } from './queries';
import type { InsuranceSchedule, ScheduleLine, ScheduleLocationGroup } from './insurance-schedule';

/**
 * The insurance / estate schedule (feature-gap G1): a formatted, printable room-by-room
 * document of every catalogued asset with its replacement value, for an insurer / estate /
 * claim. It renders on screen with the usual design tokens and prints natively via
 * `window.print()` ("Save as PDF") — no PDF dependency (§2.4.3 native-first). The print CSS
 * (`@media print` in `styles/index.css`, keyed off the `schedule-*` classes here) drops the
 * app chrome, forces an ink-friendly light scheme regardless of theme, and paginates cleanly
 * with a repeating table header. All aggregation lives in the pure {@link useInsuranceSchedule}
 * → `buildInsuranceSchedule` seam; this screen is presentation only.
 */
export function InsuranceScheduleScreen() {
  const f = useFormatters();
  const schedule = useInsuranceSchedule();
  const empty = !schedule.data || schedule.data.itemCount === 0;

  return (
    <PageContainer>
      {/* App header + actions — dropped in print (only the document below prints). */}
      <div className="schedule-chrome">
        <PageHeader
          icon={<InsuranceScheduleIcon />}
          title="Insurance schedule"
          actions={
            <Button
              variant="outline"
              onClick={() => window.print()}
              disabled={empty}
              data-testid="print-insurance-schedule"
            >
              <PrintIcon />
              Print / Save as PDF
            </Button>
          }
        />
      </div>

      <main
        id={MAIN_CONTENT_ID}
        tabIndex={-1}
        className="schedule-doc flex flex-1 animate-rise flex-col gap-6 outline-none"
      >
        {schedule.isLoading ? (
          <div className="grid place-items-center py-16">
            <Spinner />
          </div>
        ) : schedule.isError ? (
          <p role="alert" className="py-16 text-center text-sm text-destructive">
            The schedule could not be loaded.
          </p>
        ) : empty ? (
          <p className="py-16 text-center text-sm text-muted-foreground">
            No catalogued assets to schedule yet.
          </p>
        ) : (
          <ScheduleDocument schedule={schedule.data!} formatters={f} />
        )}
      </main>
    </PageContainer>
  );
}

/** The document body: a title/metadata band, the room groups, and a grand-total footer. */
function ScheduleDocument({ schedule, formatters }: { schedule: InsuranceSchedule; formatters: Formatters }) {
  const f = formatters;
  return (
    <>
      <header className="flex flex-col gap-1 border-b border-border pb-4">
        <h2 className="text-lg font-semibold">Insurance &amp; estate schedule</h2>
        <p className="text-sm text-muted-foreground">
          Generated {f.date(schedule.generatedAt)} · {f.quantity(schedule.itemCount)}{' '}
          {plural(schedule.itemCount, 'asset')}
        </p>
        <p className="mt-1 text-sm">
          Total replacement value:{' '}
          <Money
            value={schedule.grandTotal}
            formatters={f}
            className="text-base font-semibold"
            data-testid="schedule-grand-total"
          />
        </p>
      </header>

      {schedule.groups.map((group) => (
        <ScheduleGroup key={group.locationId ?? 'unassigned'} group={group} formatters={f} />
      ))}

      <footer className="flex items-center justify-between border-t-2 border-border pt-3 text-base font-semibold">
        <span>Total replacement value</span>
        <Money value={schedule.grandTotal} formatters={f} />
      </footer>
    </>
  );
}

/** One location (room) group: a heading with its subtotal, then a per-asset table. */
function ScheduleGroup({ group, formatters }: { group: ScheduleLocationGroup; formatters: Formatters }) {
  const f = formatters;
  return (
    <section className="flex flex-col gap-2">
      <div className="schedule-group-heading flex flex-wrap items-baseline justify-between gap-2 border-b border-border pb-1">
        <h3 className="font-semibold">{group.locationPath}</h3>
        <span className="text-sm text-muted-foreground">
          {f.quantity(group.lines.length)} {plural(group.lines.length, 'item')} · subtotal{' '}
          <Money value={group.subtotal} formatters={f} className="font-medium text-foreground" />
        </span>
      </div>

      <div className="schedule-table-scroll overflow-x-auto">
        <table className="schedule-table w-full text-sm">
          <caption className="sr-only">Assets in {group.locationPath}</caption>
          <thead>
            <tr className="text-left text-xs uppercase tracking-wide text-muted-foreground">
              <th scope="col" className="py-2 pr-3 font-medium">
                Photo
              </th>
              <th scope="col" className="py-2 pr-3 font-medium">
                Item
              </th>
              <th scope="col" className="py-2 pr-3 font-medium">
                Serial
              </th>
              <th scope="col" className="py-2 pr-3 text-right font-medium">
                Purchase price
              </th>
              <th scope="col" className="py-2 pr-3 font-medium">
                Acquired
              </th>
              <th scope="col" className="py-2 pr-3 font-medium">
                Warranty
              </th>
              <th scope="col" className="py-2 pr-3 font-medium">
                Condition
              </th>
              <th scope="col" className="py-2 text-right font-medium">
                Replacement value
              </th>
            </tr>
          </thead>
          <tbody>
            {group.lines.map((line) => (
              <ScheduleRow key={line.id} line={line} formatters={f} />
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

/** A single asset row. */
function ScheduleRow({ line, formatters }: { line: ScheduleLine; formatters: Formatters }) {
  const f = formatters;
  return (
    <tr className="border-t border-border align-middle">
      <td className="py-2 pr-3">
        <Thumbnail
          bytes={line.thumbnail}
          alt={line.name}
          className="schedule-photo size-12 rounded-md border border-border"
        />
      </td>
      <td className="py-2 pr-3 font-medium">
        {line.name}
        {line.quantity !== 1 ? (
          <span className="block text-xs font-normal text-muted-foreground">
            Qty {f.quantity(line.quantity)}
          </span>
        ) : null}
      </td>
      <td className="py-2 pr-3 tabular-nums">
        {line.serialNo != null ? line.serialNo : <span className="text-muted-foreground">—</span>}
      </td>
      <td className="py-2 pr-3 text-right">
        <Money value={line.purchasePrice ?? Number.NaN} formatters={f} />
      </td>
      <td className="py-2 pr-3 whitespace-nowrap">{formatAcquired(line.acquiredAt, f)}</td>
      <td className={cn('py-2 pr-3 whitespace-nowrap', WARRANTY_STATUS_COLOR_CLASS[line.warranty])}>
        {WARRANTY_STATUS_LABEL[line.warranty]}
      </td>
      <td className="py-2 pr-3 whitespace-nowrap">
        {line.condition ? (
          <span className={CONDITION_COLOR_CLASS[line.condition]}>{CONDITION_LABELS[line.condition]}</span>
        ) : (
          <span className="text-muted-foreground">—</span>
        )}
      </td>
      <td className="py-2 text-right font-medium">
        <Money value={line.replacementValue} formatters={f} />
      </td>
    </tr>
  );
}

/** Format an ISO `YYYY-MM-DD` acquisition date for display, or an em-dash when unset/invalid. */
function formatAcquired(acquiredAt: string | null, f: Formatters): string {
  if (!acquiredAt) return '—';
  const ms = Date.parse(acquiredAt);
  return Number.isFinite(ms) ? f.date(ms) : '—';
}
