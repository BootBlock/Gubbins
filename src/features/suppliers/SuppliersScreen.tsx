import { useEffect, useRef, useState } from 'react';
import {
  Button,
  Input,
  InputClearButton,
  LiveRegion,
  PageContainer,
  PageHeader,
  Pagination,
  Surface,
  pageCount,
  useSearchEscapeToClear,
  MAIN_CONTENT_ID,
} from '@/components/foundry';
import { AddIcon, MergeIcon, SearchIcon, SupplierIcon } from '@/components/icons';
import { MAX_PAGE_SIZE, type SupplierWithCounts } from '@/db/repositories';
import { useT } from '@/features/i18n';
import { PAGE_SIZE_BOUNDS, PAGE_SIZE_PRESETS } from '@/features/settings/settings';
import { cn } from '@/lib/utils';
import { usePreferencesStore } from '@/state/stores/usePreferencesStore';
import { MergeSuppliersDialog } from './components/MergeSuppliersDialog';
import { SupplierFormDialog } from './components/SupplierFormDialog';
import { useSupplierCount, useSupplierPage } from './queries';

/**
 * Manage the supplier dictionary (issue #384): add, edit, merge and delete the suppliers shared
 * by supplier parts and purchase orders.
 *
 * A supplier used to be free text re-typed on every part and every order, so the same company
 * spelled two ways was two unrelated strings — nothing could rename it and nothing could
 * reconcile the variants. This screen is where that is tidied: fix a name once and it changes
 * everywhere, or fold a duplicate into the supplier it should always have been.
 *
 * **Every supplier is reachable, however many there are** (issue #386). The list used to read a
 * single bounded page and slice it client-side, which left anything sorting past that page
 * un-editable, un-mergeable and un-deletable on the very screen meant to manage all of it. Both
 * the page and the name filter are now resolved by the database, so:
 *
 * - **Searching** reaches any supplier by name whatever the view preference — the fastest route
 *   to one you can name, and the one that doesn't care how long the list is.
 * - **Paging** walks the whole dictionary when the app-wide `Pagination` view mode is on.
 *
 * With that mode off the read is still one bounded page (the shared preference decides how lists
 * look, not this screen) — so the truncation note stays, now saying how many suppliers there
 * actually are and pointing at the search box rather than merely disclosing a dead end.
 */
export function SuppliersScreen() {
  const t = useT();
  const paginated = usePreferencesStore((s) => s.paginateLists);
  const defaultPageSize = usePreferencesStore((s) => s.defaultPageSize);
  const setDefaultPageSize = usePreferencesStore((s) => s.setDefaultPageSize);

  const [search, setSearch] = useState('');
  const searchRef = useRef<HTMLInputElement>(null);
  const searching = search.trim().length > 0;
  // Escape clears the box before it means anything else, via the shared searchable-surface seam.
  useSearchEscapeToClear(searching, searchRef, () => setSearch(''));

  const [page, setPage] = useState(1);
  const [editing, setEditing] = useState<SupplierWithCounts | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [mergeSource, setMergeSource] = useState<SupplierWithCounts | undefined>(undefined);
  const [mergeOpen, setMergeOpen] = useState(false);
  const [announcement, setAnnouncement] = useState('');

  // Unpaginated, the screen shows as much as one strict-pagination page holds — the same single
  // bounded read it has always done, and the case the truncation note below covers. There is
  // then only ever one page to be on, so the read is pinned to the first: switching the
  // preference off with a page number left over would otherwise strand the user on a tail slice
  // with no control to get back, under a note claiming it was the *first* N suppliers.
  const pageSize = paginated ? defaultPageSize : MAX_PAGE_SIZE;
  const currentPage = paginated ? page : 1;
  const suppliersQuery = useSupplierPage(search.trim(), currentPage, pageSize);
  const matchCountQuery = useSupplierCount(search.trim());
  // The size of the whole dictionary, independent of the filter — what "is there anything to
  // merge" is judged on. Resolves to the same query as the one above whenever nothing is typed.
  const dictionaryCountQuery = useSupplierCount('');
  const suppliers = suppliersQuery.data?.rows ?? [];
  const total = matchCountQuery.data ?? 0;
  const pages = pageCount(total, pageSize);
  // The unpaginated read can only show its one page; say how much of the list that is rather
  // than leaving the rest silently out of reach.
  const truncated = !paginated && total > suppliers.length;

  // Narrowing the filter (or shrinking the page size) can strand the user past the last page.
  useEffect(() => {
    setPage(1);
  }, [search, pageSize]);
  // Merging or deleting the last supplier on the final page leaves the page out of range.
  // Updated functionally so it clamps whatever page is *pending* — the reset above runs in the
  // same commit, and an absolute `setPage(pages)` here would overwrite the 1 it just queued.
  useEffect(() => {
    if (pages > 0) setPage((current) => Math.min(current, pages));
  }, [pages]);

  const openMerge = (source?: SupplierWithCounts) => {
    setMergeSource(source);
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
              // Judged on the whole dictionary, not the loaded page or the filtered view: one
              // visible row does not mean there is only one supplier to merge.
              disabled={(dictionaryCountQuery.data ?? 0) < 2}
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

          {/* Name search. `pr-9` reserves the clear button's lane so the two never overlap. */}
          <div className="relative max-w-sm">
            <SearchIcon
              aria-hidden
              className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
            />
            <Input
              ref={searchRef}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={t('suppliers.search.placeholder')}
              aria-label={t('suppliers.search.label')}
              className={cn('pl-9', searching && 'pr-9')}
              data-testid="suppliers-search"
            />
            {searching ? (
              <InputClearButton
                label={t('suppliers.search.clear')}
                onClick={() => {
                  setSearch('');
                  searchRef.current?.focus();
                }}
                className="absolute right-2 top-1/2 -translate-y-1/2"
              />
            ) : null}
          </div>

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
            // "No suppliers yet" would be wrong when a filter is what emptied the list, and it
            // would send the user to add a supplier they may well already have.
            <Surface className="flex flex-1 flex-col items-center justify-center gap-2 p-8 text-center">
              <SupplierIcon aria-hidden className="size-8 text-muted-foreground/60" />
              <p className="text-sm text-muted-foreground">
                {searching
                  ? t('suppliers.search.empty', { vars: { query: search.trim() } })
                  : t('suppliers.list.empty')}
              </p>
            </Surface>
          ) : (
            <>
              <ul className="flex flex-col gap-1.5">
                {suppliers.map((supplier) => (
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
                  totalItems={total}
                  data-testid="suppliers-pagination"
                />
              ) : null}
              {truncated ? (
                <p className="text-xs text-muted-foreground" data-testid="suppliers-truncated">
                  {t('suppliers.list.truncated', {
                    vars: { shown: suppliers.length, total },
                  })}
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
          onClose={() => setAddOpen(false)}
          onMerge={openMerge}
          onAnnounce={setAnnouncement}
        />
      ) : null}

      {editing ? (
        <SupplierFormDialog
          supplier={editing}
          onClose={() => setEditing(null)}
          onMerge={openMerge}
          onAnnounce={setAnnouncement}
        />
      ) : null}

      {mergeOpen ? (
        <MergeSuppliersDialog
          initialSource={mergeSource}
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
