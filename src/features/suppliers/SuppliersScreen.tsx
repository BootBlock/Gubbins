import { useEffect, useMemo, useState } from 'react';
import {
  Button,
  LiveRegion,
  PageContainer,
  PageHeader,
  Pagination,
  Surface,
  pageCount,
  pageSliceBounds,
  MAIN_CONTENT_ID,
} from '@/components/foundry';
import { AddIcon, MergeIcon, SupplierIcon } from '@/components/icons';
import type { SupplierWithCounts } from '@/db/repositories';
import { useT } from '@/features/i18n';
import { PAGE_SIZE_BOUNDS, PAGE_SIZE_PRESETS } from '@/features/settings/settings';
import { usePreferencesStore } from '@/state/stores/usePreferencesStore';
import { MergeSuppliersDialog } from './components/MergeSuppliersDialog';
import { SupplierFormDialog } from './components/SupplierFormDialog';
import { useSuppliers } from './queries';

/**
 * Manage the supplier dictionary (issue #384): add, edit, merge and delete the suppliers shared
 * by supplier parts and purchase orders.
 *
 * A supplier used to be free text re-typed on every part and every order, so the same company
 * spelled two ways was two unrelated strings — nothing could rename it and nothing could
 * reconcile the variants. This screen is where that is tidied: fix a name once and it changes
 * everywhere, or fold a duplicate into the supplier it should always have been.
 *
 * The dictionary is small and hand-curated, so it is read as a single bounded page and paged
 * **client-side** through the shared `pageSliceBounds` seam — the same opt-in `Pagination`
 * behaviour every other list screen offers, without a per-page round trip for a list that
 * comfortably fits in one.
 */
export function SuppliersScreen() {
  const t = useT();
  const paginated = usePreferencesStore((s) => s.paginateLists);
  const defaultPageSize = usePreferencesStore((s) => s.defaultPageSize);
  const setDefaultPageSize = usePreferencesStore((s) => s.setDefaultPageSize);

  const suppliersQuery = useSuppliers();
  const suppliers = useMemo(() => suppliersQuery.data?.rows ?? [], [suppliersQuery.data]);
  // The read is bounded (§2.1); say so rather than quietly showing a truncated dictionary on the
  // very screen meant to manage all of it.
  const truncated = suppliersQuery.data?.hasMore ?? false;

  const [page, setPage] = useState(1);
  const [editing, setEditing] = useState<SupplierWithCounts | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [mergeSourceId, setMergeSourceId] = useState<string | null>(null);
  const [mergeOpen, setMergeOpen] = useState(false);
  const [announcement, setAnnouncement] = useState('');

  const pageSize = paginated ? defaultPageSize : suppliers.length || 1;
  const pages = pageCount(suppliers.length, pageSize);
  const { start, end } = pageSliceBounds(page, pageSize, suppliers.length);
  const visible = paginated ? suppliers.slice(start, end) : suppliers;

  // Merging or deleting the last supplier on the final page leaves the page out of range.
  useEffect(() => {
    if (paginated && pages > 0 && page > pages) setPage(pages);
  }, [paginated, pages, page]);

  const openMerge = (source?: SupplierWithCounts) => {
    setMergeSourceId(source?.id ?? null);
    setEditing(null);
    setMergeOpen(true);
  };

  return (
    <PageContainer>
      <PageHeader
        icon={<SupplierIcon />}
        title={t('suppliers.title')}
        actions={
          <>
            <Button
              variant="outline"
              onClick={() => openMerge()}
              disabled={suppliers.length < 2}
              data-testid="suppliers-merge"
            >
              <MergeIcon aria-hidden />
              {t('suppliers.merge.action')}
            </Button>
            <Button onClick={() => setAddOpen(true)} data-testid="suppliers-add">
              <AddIcon aria-hidden />
              {t('suppliers.add.action')}
            </Button>
          </>
        }
      />

      <main
        id={MAIN_CONTENT_ID}
        tabIndex={-1}
        className="flex flex-1 animate-rise flex-col gap-6 outline-none"
      >
        <p className="max-w-2xl text-sm text-muted-foreground">{t('suppliers.intro')}</p>

        <section aria-labelledby="suppliers-list-heading" className="flex flex-1 flex-col gap-3">
          <h2 id="suppliers-list-heading" className="text-sm font-semibold text-foreground">
            {t('suppliers.list.heading')}
          </h2>

          {suppliersQuery.isLoading ? (
            // The loading / error / empty states fill the list region (rather than sitting in a
            // small card) so this screen sizes like the master-detail list screens it sits beside.
            <Surface className="grid flex-1 place-items-center p-8 text-center">
              <p className="text-sm text-muted-foreground">{t('suppliers.list.loading')}</p>
            </Surface>
          ) : suppliersQuery.isError ? (
            // Never fall through to the empty state on failure — "No suppliers yet" would be a
            // lie, and it hides a real error behind copy that reads like success.
            <Surface className="flex flex-1 flex-col items-center justify-center gap-3 p-8 text-center">
              <p role="alert" className="text-sm text-destructive">
                {t('suppliers.list.error')}
              </p>
              <Button variant="outline" onClick={() => void suppliersQuery.refetch()}>
                {t('suppliers.list.retry')}
              </Button>
            </Surface>
          ) : suppliers.length === 0 ? (
            <Surface className="flex flex-1 flex-col items-center justify-center gap-2 p-8 text-center">
              <SupplierIcon aria-hidden className="size-8 text-muted-foreground/60" />
              <p className="text-sm text-muted-foreground">{t('suppliers.list.empty')}</p>
            </Surface>
          ) : (
            <>
              <ul className="flex flex-col gap-1.5">
                {visible.map((supplier) => (
                  <li key={supplier.id}>
                    <SupplierRow supplier={supplier} onEdit={() => setEditing(supplier)} />
                  </li>
                ))}
              </ul>
              {paginated ? (
                <Pagination
                  page={page}
                  pageCount={pages}
                  onPageChange={setPage}
                  pageSize={defaultPageSize}
                  onPageSizeChange={setDefaultPageSize}
                  pageSizeOptions={PAGE_SIZE_PRESETS}
                  minPageSize={PAGE_SIZE_BOUNDS.min}
                  maxPageSize={PAGE_SIZE_BOUNDS.max}
                  totalItems={suppliers.length}
                  data-testid="suppliers-pagination"
                />
              ) : null}
              {truncated ? (
                <p className="text-xs text-muted-foreground" data-testid="suppliers-truncated">
                  {t('suppliers.list.truncated', { vars: { shown: suppliers.length } })}
                </p>
              ) : null}
            </>
          )}
        </section>
      </main>

      <LiveRegion visuallyHidden>{announcement}</LiveRegion>

      {addOpen ? (
        <SupplierFormDialog
          supplier={null}
          others={suppliers}
          onClose={() => setAddOpen(false)}
          onMerge={openMerge}
          onAnnounce={setAnnouncement}
        />
      ) : null}

      {editing ? (
        <SupplierFormDialog
          supplier={editing}
          others={suppliers.filter((s) => s.id !== editing.id)}
          onClose={() => setEditing(null)}
          onMerge={openMerge}
          onAnnounce={setAnnouncement}
        />
      ) : null}

      {mergeOpen ? (
        <MergeSuppliersDialog
          suppliers={suppliers}
          initialSourceId={mergeSourceId ?? undefined}
          onClose={() => setMergeOpen(false)}
          onAnnounce={setAnnouncement}
        />
      ) : null}
    </PageContainer>
  );
}

/**
 * One supplier in the list: its name and details, with the part/order counts that say how much
 * of the catalogue and how much spend history hang off it — the two numbers that say what
 * deleting it would cost, and whether merging it is the better move.
 */
function SupplierRow({
  supplier,
  onEdit,
}: {
  readonly supplier: SupplierWithCounts;
  readonly onEdit: () => void;
}) {
  const t = useT();
  return (
    <button
      type="button"
      onClick={onEdit}
      className="flex w-full flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border border-border bg-card px-3 py-2 text-left transition-colors hover:bg-secondary"
    >
      <span className="text-sm font-medium text-foreground">{supplier.name}</span>
      {supplier.currency ? (
        <span className="rounded-full bg-primary/15 px-2 py-0.5 text-xs font-medium text-primary">
          {supplier.currency}
        </span>
      ) : null}
      {supplier.url ? <span className="truncate text-xs text-muted-foreground">{supplier.url}</span> : null}
      <span className="ml-auto whitespace-nowrap text-xs text-muted-foreground">
        {t('suppliers.counts.parts', { vars: { count: supplier.partCount, n: supplier.partCount } })}
        {' · '}
        {t('suppliers.counts.orders', {
          vars: { count: supplier.orderCount, n: supplier.orderCount },
        })}
      </span>
      {supplier.note ? (
        <span className="w-full truncate text-xs text-muted-foreground">{supplier.note}</span>
      ) : null}
    </button>
  );
}
