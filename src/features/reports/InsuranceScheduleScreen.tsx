import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Button,
  Checkbox,
  InfoHint,
  LiveRegion,
  Money,
  PageContainer,
  PageHeader,
  Pagination,
  Spinner,
  MAIN_CONTENT_ID,
  pageCount,
  clampPage,
} from '@/components/foundry';
import { InsuranceScheduleIcon, PrintIcon } from '@/components/icons';
import { cn } from '@/lib/utils';
import { plural } from '@/lib/plural';
import type { Formatters } from '@/lib/format';
import { useFormatters } from '@/lib/useFormatters';
import { useT } from '@/features/i18n';
import { Thumbnail } from '@/features/inventory/components/Thumbnail';
import {
  CONDITION_COLOR_CLASS,
  CONDITION_LABELS,
  WARRANTY_STATUS_COLOR_CLASS,
  WARRANTY_STATUS_LABEL,
} from '@/features/inventory/components/inventory-ui';
import { PAGE_SIZE_BOUNDS, PAGE_SIZE_PRESETS } from '@/features/settings/settings';
import { TabularExportMenu } from '@/features/export/TabularExportMenu';
import { buildScheduleExport, scheduleExportFilename } from './schedule-export';
import { usePreferencesStore } from '@/state/stores/usePreferencesStore';
import { ForeignCurrencyNotice } from './components/ForeignCurrencyNotice';
import {
  loadFullScheduleLines,
  useForeignCurrencyCostCount,
  useInsuranceSchedulePage,
  useInsuranceScheduleSummary,
} from './queries';
import {
  PRINT_FULL_LIMIT,
  PRINT_PHOTO_LIMIT,
  type InsuranceScheduleSummary,
  type ScheduleGroupSummary,
  type ScheduleLine,
} from './insurance-schedule';

/**
 * The insurance / estate schedule (feature-gap G1): a formatted, printable room-by-room
 * document of every catalogued asset with its replacement value, for an insurer / estate /
 * claim.
 *
 * **On screen the document is paged** (issue #163). A schedule covers every catalogued asset, so
 * reading it in one go does not scale — the previous whole-document read pulled every asset's
 * thumbnail BLOB into a single array, which at 100k assets is hundreds of megabytes and takes
 * the tab with it. Totals now come from a bounded summary read, lines come a page at a time, and
 * photos are fetched only when the reader asks for them.
 *
 * **What prints is never the paged view.** The print CSS hides `.schedule-window` outright and
 * shows `.schedule-print-doc` instead, so no route to the printer — the button, Ctrl+P, or the
 * browser's own menu — can emit one page of a schedule that reads as the whole thing. An insurer
 * or executor has no way to tell a truncated schedule from a complete one, so the structure
 * rules it out rather than relying on the reader noticing. There are two artefacts, each headed
 * with what it is: a room-subtotal **summary** (always available, always short) and the **full**
 * schedule, which the Print button loads completely before printing.
 */
export function InsuranceScheduleScreen() {
  const f = useFormatters();
  const t = useT();
  const summary = useInsuranceScheduleSummary();
  const defaultPageSize = usePreferencesStore((s) => s.defaultPageSize);
  const setDefaultPageSize = usePreferencesStore((s) => s.setDefaultPageSize);

  const [page, setPage] = useState(1);
  const [includePhotos, setIncludePhotos] = useState(false);

  const itemCount = summary.data?.itemCount ?? 0;
  const totalPages = pageCount(itemCount, defaultPageSize);
  const empty = !summary.data || itemCount === 0;

  // Keep the requested page inside the document as it changes underneath the reader — the same
  // reset-then-clamp pair the inventory list uses.
  useEffect(() => {
    setPage(1);
  }, [defaultPageSize, includePhotos]);
  useEffect(() => {
    setPage((current) => clampPage(current, totalPages));
  }, [totalPages]);

  const pageQuery = useInsuranceSchedulePage(
    summary.data?.groups,
    (page - 1) * defaultPageSize,
    defaultPageSize,
    includePhotos,
  );

  const print = usePreparedPrint(summary.data, includePhotos, t);

  return (
    <PageContainer>
      {/* App header + actions — dropped in print (only the document below prints). */}
      <div className="schedule-chrome">
        <PageHeader
          icon={<InsuranceScheduleIcon />}
          title="Insurance schedule"
          actions={
            <div className="flex flex-wrap items-center gap-3">
              <div className="flex items-center gap-1.5 text-sm">
                {/* The help badge sits *outside* the label so tapping it opens the tooltip
                    rather than toggling the checkbox. */}
                <label className="flex items-center gap-2">
                  <Checkbox
                    checked={includePhotos}
                    onChange={(e) => setIncludePhotos(e.target.checked)}
                    data-testid="schedule-include-photos"
                  />
                  {t('reports.insurance.photos.label')}
                </label>
                <InfoHint content={t('reports.insurance.photos.help')} />
              </div>
              <Button
                variant="outline"
                onClick={print.start}
                disabled={empty || print.busy || print.tooLarge}
                aria-busy={print.busy}
                data-testid="print-insurance-schedule"
              >
                <PrintIcon />
                {print.busy ? t('reports.insurance.print.preparing') : 'Print / Save as PDF'}
              </Button>
              {print.busy ? (
                <Button variant="ghost" onClick={print.cancel} data-testid="cancel-prepare-schedule">
                  {t('reports.insurance.print.cancel')}
                </Button>
              ) : null}
              {/* The way out for a schedule too large to print — and a useful export at any
                  size. Photos are never in a spreadsheet, so the rows are always text. */}
              <TabularExportMenu
                build={async (format) => {
                  const lines = await loadFullScheduleLines(summary.data!.groups, false, () => {});
                  return buildScheduleExport(format, summary.data!, lines);
                }}
                filename={scheduleExportFilename}
                triggerLabel={t('reports.insurance.export.trigger')}
                menuLabel={t('reports.insurance.export.menuLabel')}
                toastHeading={t('reports.insurance.export.toast')}
                disabled={empty}
                testIdPrefix="export-schedule"
              />
            </div>
          }
        />
        {print.tooLarge ? (
          <p className="mt-2 text-sm text-muted-foreground" data-testid="schedule-too-large">
            {t('reports.insurance.print.tooLarge', {
              vars: { count: f.quantity(itemCount), limit: f.quantity(print.limit) },
            })}
          </p>
        ) : null}
        <LiveRegion>{print.status}</LiveRegion>
      </div>

      <main
        id={MAIN_CONTENT_ID}
        tabIndex={-1}
        className="schedule-doc flex flex-1 animate-rise flex-col gap-6 outline-none"
      >
        {summary.isLoading ? (
          <div className="grid place-items-center py-16">
            <Spinner />
          </div>
        ) : summary.isError ? (
          <p role="alert" className="py-16 text-center text-sm text-destructive">
            The schedule could not be loaded.
          </p>
        ) : empty ? (
          <p className="py-16 text-center text-sm text-muted-foreground">
            No catalogued assets to schedule yet.
          </p>
        ) : (
          <>
            {/* Screen-only: the paged reading view. Hidden in print (see the `.schedule-window`
                rule in styles/index.css) because part of a schedule must never reach paper. */}
            <section className="schedule-window flex flex-col gap-6">
              <ScheduleHeader summary={summary.data!} formatters={f} />
              {pageQuery.isPending && !pageQuery.data ? (
                <div className="grid place-items-center py-16">
                  <Spinner />
                </div>
              ) : (
                <PagedGroups
                  summary={summary.data!}
                  slices={pageQuery.data ?? []}
                  formatters={f}
                  includePhotos={includePhotos}
                  t={t}
                />
              )}
              <Pagination
                page={page}
                pageCount={totalPages}
                onPageChange={setPage}
                pageSize={defaultPageSize}
                onPageSizeChange={setDefaultPageSize}
                pageSizeOptions={PAGE_SIZE_PRESETS}
                minPageSize={PAGE_SIZE_BOUNDS.min}
                maxPageSize={PAGE_SIZE_BOUNDS.max}
                totalItems={itemCount}
                data-testid="schedule-pagination"
              />
              <ScheduleFooter total={summary.data!.grandTotal} formatters={f} />
            </section>

            {/* Print-only: whichever complete artefact is ready. Never derived from the paged
                view above, so what prints always matches its own heading. */}
            <section className="schedule-print-doc" data-testid="schedule-print-doc">
              <PrintDocument
                summary={summary.data!}
                lines={print.lines}
                formatters={f}
                includePhotos={includePhotos}
                t={t}
              />
            </section>
          </>
        )}
      </main>
    </PageContainer>
  );
}

/** One slice of a page: a room, and the lines of it that fall on this page. */
interface PageSlice {
  readonly locationId: string | null;
  readonly lines: readonly ScheduleLine[];
}

/**
 * Drive the "prepare the whole document, then print" flow.
 *
 * The document is loaded into state and `window.print()` is called from an effect once React has
 * committed it — never with `flushSync` inside the click handler, which would raise the print
 * dialog against a half-built page. When photos are on, every image is decoded first or the
 * thumbnails print blank. `afterprint` drops the document again so a whole schedule's BLOBs are
 * not held alive once the print is over, and a prepared document is dropped whenever the photo
 * choice or the underlying summary changes — a document that no longer matches the settings it
 * was built under is a wrong document, not a stale one.
 */
function usePreparedPrint(
  summary: InsuranceScheduleSummary | undefined,
  includePhotos: boolean,
  t: ReturnType<typeof useT>,
) {
  const [lines, setLines] = useState<Map<string | null, ScheduleLine[]> | null>(null);
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);
  const abort = useRef<AbortController | null>(null);

  const itemCount = summary?.itemCount ?? 0;
  const limit = includePhotos ? PRINT_PHOTO_LIMIT : PRINT_FULL_LIMIT;
  const tooLarge = itemCount > limit;

  // A prepared document is only valid for the settings it was prepared under.
  useEffect(() => {
    setLines(null);
  }, [includePhotos, summary]);

  useEffect(() => {
    const drop = () => setLines(null);
    window.addEventListener('afterprint', drop);
    return () => window.removeEventListener('afterprint', drop);
  }, []);

  // Print only once the full document has actually been committed to the DOM.
  useEffect(() => {
    if (lines === null) return;
    let cancelled = false;
    void (async () => {
      // Thumbnails are decoded before the dialog opens, or they print as blanks.
      const images = Array.from(document.querySelectorAll<HTMLImageElement>('.schedule-print-doc img'));
      await Promise.all(images.map((img) => img.decode().catch(() => undefined)));
      if (!cancelled) window.print();
    })();
    return () => {
      cancelled = true;
    };
  }, [lines]);

  const start = useCallback(async () => {
    if (summary === undefined) return;
    const controller = new AbortController();
    abort.current = controller;
    setBusy(true);
    setStatus(t('reports.insurance.print.preparing'));
    try {
      const loaded = await loadFullScheduleLines(
        summary.groups,
        includePhotos,
        (done, total) =>
          setStatus(
            t('reports.insurance.print.progress', {
              vars: { done: String(done), total: String(total) },
            }),
          ),
        controller.signal,
      );
      setLines(loaded);
      setStatus(t('reports.insurance.print.ready'));
    } catch (err) {
      setStatus(
        (err as Error)?.name === 'AbortError'
          ? t('reports.insurance.print.cancelled')
          : t('reports.insurance.print.failed'),
      );
    } finally {
      setBusy(false);
      abort.current = null;
    }
  }, [summary, includePhotos, t]);

  const cancel = useCallback(() => abort.current?.abort(), []);

  return { lines, status, busy, start, cancel, tooLarge, limit };
}

/** The document's title band: when it was generated, how many assets, and the grand total. */
function ScheduleHeader({
  summary,
  formatters,
}: {
  summary: InsuranceScheduleSummary;
  formatters: Formatters;
}) {
  const f = formatters;
  const excluded = useForeignCurrencyCostCount();
  const baseCurrency = usePreferencesStore((s) => s.baseCurrency);
  return (
    <>
      <header className="flex flex-col gap-1 border-b border-border pb-4">
        <h2 className="text-lg font-semibold">Insurance &amp; estate schedule</h2>
        <p className="text-sm text-muted-foreground">
          Generated {f.date(summary.generatedAt)} · {f.quantity(summary.itemCount)}{' '}
          {plural(summary.itemCount, 'asset')}
        </p>
        <p className="mt-1 text-sm">
          Total replacement value:{' '}
          <Money
            value={summary.grandTotal}
            formatters={f}
            className="text-base font-semibold"
            data-testid="schedule-grand-total"
          />
        </p>
      </header>
      {/* Sits inside the document, not the app chrome: a schedule is read by an insurer or
          executor who has no way of knowing that stock priced in another currency was left out
          of the grand total, so the caveat has to travel with the paper (#284). */}
      <ForeignCurrencyNotice count={excluded.data} baseCurrency={baseCurrency} />
    </>
  );
}

/** The closing grand-total rule. */
function ScheduleFooter({ total, formatters }: { total: number; formatters: Formatters }) {
  return (
    <footer className="flex items-center justify-between border-t-2 border-border pt-3 text-base font-semibold">
      <span>Total replacement value</span>
      <Money value={total} formatters={formatters} />
    </footer>
  );
}

/** The rooms touched by the current page, each showing how much of it is on screen. */
function PagedGroups({
  summary,
  slices,
  formatters,
  includePhotos,
  t,
}: {
  summary: InsuranceScheduleSummary;
  slices: readonly PageSlice[];
  formatters: Formatters;
  includePhotos: boolean;
  t: ReturnType<typeof useT>;
}) {
  const byId = useMemo(() => new Map(summary.groups.map((g) => [g.locationId, g])), [summary.groups]);
  return (
    <>
      {slices.map((slice) => {
        const group = byId.get(slice.locationId);
        if (group === undefined) return null;
        return (
          <ScheduleGroup
            key={group.locationId ?? 'unassigned'}
            group={group}
            lines={slice.lines}
            formatters={formatters}
            includePhotos={includePhotos}
            // A partial room must say so. A bare count beside part of a room reads as the whole
            // room — exactly the misreading the print rules exist to prevent.
            showingLabel={
              slice.lines.length < group.itemCount
                ? t('reports.insurance.group.showingOf', {
                    vars: {
                      shown: formatters.quantity(slice.lines.length),
                      total: formatters.quantity(group.itemCount),
                    },
                  })
                : null
            }
          />
        );
      })}
    </>
  );
}

/** One location (room) group: a heading with its subtotal, then a per-asset table. */
function ScheduleGroup({
  group,
  lines,
  formatters,
  includePhotos,
  showingLabel,
}: {
  group: ScheduleGroupSummary;
  lines: readonly ScheduleLine[];
  formatters: Formatters;
  includePhotos: boolean;
  showingLabel?: string | null;
}) {
  const f = formatters;
  return (
    <section className="flex flex-col gap-2">
      <div className="schedule-group-heading flex flex-wrap items-baseline justify-between gap-2 border-b border-border pb-1">
        <h3 className="font-semibold">{group.locationPath}</h3>
        <span className="text-sm text-muted-foreground">
          {showingLabel ? (
            <>{showingLabel} · </>
          ) : (
            <>
              {f.quantity(group.itemCount)} {plural(group.itemCount, 'item')} ·{' '}
            </>
          )}
          subtotal <Money value={group.subtotal} formatters={f} className="font-medium text-foreground" />
        </span>
      </div>

      <div className="schedule-table-scroll overflow-x-auto">
        <table className="schedule-table w-full text-sm">
          <caption className="sr-only">Assets in {group.locationPath}</caption>
          <thead>
            <tr className="text-left text-xs uppercase tracking-wide text-muted-foreground">
              {includePhotos ? (
                <th scope="col" className="py-2 pr-3 font-medium">
                  Photo
                </th>
              ) : null}
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
            {lines.map((line) => (
              <ScheduleRow key={line.id} line={line} formatters={f} includePhotos={includePhotos} />
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

/** A single asset row. */
function ScheduleRow({
  line,
  formatters,
  includePhotos,
}: {
  line: ScheduleLine;
  formatters: Formatters;
  includePhotos: boolean;
}) {
  const f = formatters;
  return (
    <tr className="border-t border-border align-middle">
      {includePhotos ? (
        <td className="py-2 pr-3">
          <Thumbnail
            bytes={line.thumbnail}
            alt={line.name}
            className="schedule-photo size-12 rounded-md border border-border"
          />
        </td>
      ) : null}
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

/**
 * The artefact that actually prints: the full schedule once it has been prepared, otherwise a
 * room-subtotal summary. Both carry a heading naming which they are, so a printed page can never
 * misrepresent its own completeness.
 */
function PrintDocument({
  summary,
  lines,
  formatters,
  includePhotos,
  t,
}: {
  summary: InsuranceScheduleSummary;
  lines: Map<string | null, ScheduleLine[]> | null;
  formatters: Formatters;
  includePhotos: boolean;
  t: ReturnType<typeof useT>;
}) {
  const f = formatters;
  const full = lines !== null;
  // Count what is actually on the page, not what the summary said there would be. The two agree
  // unless the inventory changed mid-load, and in that case the heading must describe the
  // document in front of the reader — a heading is only a guarantee if it is derived from the
  // thing it describes.
  const printedCount = full
    ? summary.groups.reduce((sum, g) => sum + (lines.get(g.locationId)?.length ?? 0), 0)
    : summary.itemCount;
  return (
    <>
      <header className="flex flex-col gap-1 border-b border-border pb-4">
        <h2 className="text-lg font-semibold">Insurance &amp; estate schedule</h2>
        <p className="text-sm font-medium" data-testid="schedule-print-heading">
          {full
            ? t('reports.insurance.print.fullHeading', { vars: { count: f.quantity(printedCount) } })
            : t('reports.insurance.print.summaryHeading')}
        </p>
        <p className="text-sm text-muted-foreground">
          Generated {f.date(summary.generatedAt)} · {f.quantity(printedCount)} {plural(printedCount, 'asset')}
        </p>
        {full ? null : (
          <p className="text-sm text-muted-foreground">{t('reports.insurance.print.summaryCaveat')}</p>
        )}
      </header>

      {full ? (
        summary.groups.map((group) => (
          <ScheduleGroup
            key={group.locationId ?? 'unassigned'}
            group={group}
            lines={lines.get(group.locationId) ?? []}
            formatters={f}
            includePhotos={includePhotos}
          />
        ))
      ) : (
        <table className="schedule-table w-full text-sm">
          <caption className="sr-only">{t('reports.insurance.print.summaryHeading')}</caption>
          <thead>
            <tr className="text-left text-xs uppercase tracking-wide text-muted-foreground">
              <th scope="col" className="py-2 pr-3 font-medium">
                {t('reports.insurance.summaryTable.room')}
              </th>
              <th scope="col" className="py-2 pr-3 text-right font-medium">
                {t('reports.insurance.summaryTable.assets')}
              </th>
              <th scope="col" className="py-2 text-right font-medium">
                {t('reports.insurance.summaryTable.subtotal')}
              </th>
            </tr>
          </thead>
          <tbody>
            {summary.groups.map((group) => (
              <tr key={group.locationId ?? 'unassigned'} className="border-t border-border">
                <td className="py-2 pr-3">{group.locationPath}</td>
                <td className="py-2 pr-3 text-right tabular-nums">{f.quantity(group.itemCount)}</td>
                <td className="py-2 text-right font-medium">
                  <Money value={group.subtotal} formatters={f} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <ScheduleFooter total={summary.grandTotal} formatters={f} />
    </>
  );
}

/** Format an ISO `YYYY-MM-DD` acquisition date for display, or an em-dash when unset/invalid. */
function formatAcquired(acquiredAt: string | null, f: Formatters): string {
  if (!acquiredAt) return '—';
  const ms = Date.parse(acquiredAt);
  return Number.isFinite(ms) ? f.calendarDate(ms) : '—';
}
