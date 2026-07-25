/**
 * Wishlist tab (feature-gap G8 — manual "to-buy" / wishlist).
 *
 * A manual list of **wanted-but-not-owned** things to buy — the counterpart to the *stock-driven*
 * Reorder / Shopping-list tab. Each entry is free-standing (a name plus an optional note, link,
 * target price and priority), added/edited via {@link WishlistEntryDialog} and removed inline.
 * All ordering/summarising lives in the pure `wishlist.ts` seam; this is glue. Design tokens +
 * Foundry primitives + WCAG 4.1.3 live regions throughout (CLAUDE.md).
 *
 * The list is read **whole** and paged client-side (issue #149) — the summary above it totals
 * every wish, so a capped read would have understated that estimate as well as hiding entries.
 */
import { useEffect, useMemo, useState } from 'react';
import {
  Button,
  LiveRegion,
  Money,
  Pagination,
  Spinner,
  Surface,
  pageCount,
  pageSliceBounds,
} from '@/components/foundry';
import {
  AddIcon,
  DeleteIcon,
  EditIcon,
  ExternalLinkIcon,
  UploadIcon,
  WishlistIcon,
} from '@/components/icons';
import { plural } from '@/lib/plural';
import { useFormatters } from '@/lib/useFormatters';
import { useT } from '@/features/i18n';
import { PAGE_SIZE_BOUNDS, PAGE_SIZE_PRESETS } from '@/features/settings/settings';
import { usePreferencesStore } from '@/state/stores/usePreferencesStore';
import type { WishlistEntry } from '@/db/repositories';
import { WISHLIST_PRIORITY_LABELS, summariseWishlist, type WishlistPriority } from './wishlist';
import {
  useCreateWishlistEntry,
  useDeleteWishlistEntry,
  useUpdateWishlistEntry,
  useWishlist,
} from './wishlist-queries';
import { WishlistEntryDialog } from './components/WishlistEntryDialog';
import { ImportPurchaseListDialog } from './components/ImportPurchaseListDialog';

/** Design-token tone for each priority badge; `NONE` shows no badge. */
const PRIORITY_TONE: Record<Exclude<WishlistPriority, 'NONE'>, string> = {
  HIGH: 'text-glyph-danger',
  MEDIUM: 'text-glyph-gauge',
  LOW: 'text-glyph-neutral',
};

export function WishlistTab() {
  const listQuery = useWishlist();
  const createEntry = useCreateWishlistEntry();
  const updateEntry = useUpdateWishlistEntry();
  const deleteEntry = useDeleteWishlistEntry();
  const f = useFormatters();

  const [dialogOpen, setDialogOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [editing, setEditing] = useState<WishlistEntry | null>(null);
  const t = useT();

  const entries = useMemo(() => listQuery.data?.rows ?? [], [listQuery.data]);
  const summary = useMemo(() => summariseWishlist(entries), [entries]);

  // App-wide list pagination (issue #20), sliced client-side: the whole list is already in
  // hand, so paging it costs no extra round trip.
  const paginated = usePreferencesStore((s) => s.paginateLists);
  const defaultPageSize = usePreferencesStore((s) => s.defaultPageSize);
  const setDefaultPageSize = usePreferencesStore((s) => s.setDefaultPageSize);
  const [page, setPage] = useState(1);
  const pages = pageCount(entries.length, defaultPageSize);
  const { start, end } = pageSliceBounds(page, defaultPageSize, entries.length);
  const visibleEntries = paginated ? entries.slice(start, end) : entries;
  // Removing the last wish on the final page leaves the page out of range.
  useEffect(() => {
    if (paginated && pages > 0 && page > pages) setPage(pages);
  }, [paginated, pages, page]);

  const openAdd = () => {
    setEditing(null);
    setDialogOpen(true);
  };
  const openEdit = (entry: WishlistEntry) => {
    setEditing(entry);
    setDialogOpen(true);
  };

  const isSaving = createEntry.isPending || updateEntry.isPending;

  return (
    <div className="flex flex-col gap-4">
      {/*
       * WCAG 4.1.3 — always-mounted polite status region for the wishlist count. Kept in the
       * DOM across loading → loaded → empty so screen readers pick up the text mutation.
       */}
      <p className="sr-only" role="status" aria-live="polite" data-testid="wishlist-count-live">
        {listQuery.isLoading
          ? 'Loading wishlist…'
          : summary.count === 0
            ? 'Your wishlist is empty.'
            : `${summary.count} ${plural(summary.count, 'item')} on your wishlist.`}
      </p>

      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-muted-foreground" data-testid="wishlist-summary">
          {summary.count === 0 ? (
            'Things you want but don’t own yet.'
          ) : (
            <>
              {summary.count} {plural(summary.count, 'item')}
              {summary.pricedCount > 0 && (
                <>
                  {' · est. '}
                  <Money value={summary.totalTargetPrice} formatters={f} />
                  {summary.pricedCount < summary.count && (
                    <span className="opacity-70"> ({summary.pricedCount} priced)</span>
                  )}
                </>
              )}
            </>
          )}
        </p>
        <div className="flex items-center gap-2">
          <Button variant="outline" onClick={() => setImportOpen(true)} data-testid="wishlist-import">
            <UploadIcon />
            {t('purchasing.import.open')}
          </Button>
          <Button variant="primary" onClick={openAdd} data-testid="wishlist-add">
            <AddIcon />
            Add wish
          </Button>
        </div>
      </div>

      {listQuery.isLoading ? (
        <Surface className="flex items-center justify-center p-8">
          <Spinner />
        </Surface>
      ) : entries.length === 0 ? (
        <Surface
          className="flex flex-col items-center gap-3 p-8 text-center text-muted-foreground"
          data-testid="wishlist-empty"
        >
          <WishlistIcon className="size-8 opacity-40" aria-hidden="true" />
          <p className="text-sm">Your wishlist is empty.</p>
          <p className="text-xs opacity-70">
            Add things you’d like to buy but don’t own yet. This is separate from the Reorder list, which
            tracks items you already stock.
          </p>
        </Surface>
      ) : (
        <>
          <Surface className="overflow-hidden p-0">
            {/* eslint-disable-next-line jsx-a11y/no-redundant-roles -- flex layout drops the <ul>'s implicit list semantics in Safari/VoiceOver, so role="list" is restored deliberately. */}
            <ul className="flex flex-col divide-y divide-border" role="list">
              {visibleEntries.map((entry) => (
                <WishlistRow
                  key={entry.id}
                  entry={entry}
                  formatters={f}
                  onEdit={() => openEdit(entry)}
                  onDelete={() => deleteEntry.mutate(entry.id)}
                  isDeleting={deleteEntry.isPending}
                />
              ))}
            </ul>
          </Surface>
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
              totalItems={entries.length}
              data-testid="wishlist-pagination"
            />
          ) : null}
          {/* The list is read whole, so this only ever appears at the read-everything safety
              ceiling — where the summary above covers only what was read, and must say so. */}
          {listQuery.data?.truncated ? (
            <p className="text-xs text-muted-foreground" data-testid="wishlist-truncated">
              {t('purchasing.wishlist.truncated', { vars: { shown: entries.length } })}
            </p>
          ) : null}
        </>
      )}

      <WishlistEntryDialog
        open={dialogOpen}
        entry={editing}
        isSaving={isSaving}
        onClose={() => setDialogOpen(false)}
        onSubmit={(input) => {
          if (editing) {
            updateEntry.mutate({ id: editing.id, input }, { onSuccess: () => setDialogOpen(false) });
          } else {
            createEntry.mutate(input, { onSuccess: () => setDialogOpen(false) });
          }
        }}
      />

      <ImportPurchaseListDialog open={importOpen} onClose={() => setImportOpen(false)} />

      <LiveRegion visuallyHidden data-testid="wishlist-mutation-live">
        {createEntry.isSuccess ? <p>Added to your wishlist.</p> : null}
        {deleteEntry.isSuccess ? <p>Removed from your wishlist.</p> : null}
      </LiveRegion>
    </div>
  );
}

function WishlistRow({
  entry,
  formatters,
  onEdit,
  onDelete,
  isDeleting,
}: {
  entry: WishlistEntry;
  formatters: ReturnType<typeof useFormatters>;
  onEdit: () => void;
  onDelete: () => void;
  isDeleting: boolean;
}) {
  const showBadge = entry.priority !== 'NONE';
  return (
    <li className="flex flex-wrap items-center gap-3 px-4 py-3" data-testid="wishlist-row">
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="truncate text-sm font-medium">{entry.name}</span>
          {showBadge && (
            <span
              className={`text-xs font-semibold ${PRIORITY_TONE[entry.priority as Exclude<WishlistPriority, 'NONE'>]}`}
              data-testid="wishlist-priority-badge"
            >
              {WISHLIST_PRIORITY_LABELS[entry.priority]}
            </span>
          )}
        </div>
        {(entry.note || entry.url) && (
          <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-muted-foreground">
            {entry.note && <span className="truncate">{entry.note}</span>}
            {entry.url && (
              <a
                href={entry.url}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 text-primary underline-offset-2 hover:underline [&_svg]:size-3"
                data-testid="wishlist-link"
              >
                <ExternalLinkIcon aria-hidden="true" />
                View
              </a>
            )}
          </div>
        )}
      </div>

      {entry.targetPrice != null && (
        <span
          className="text-sm tabular-nums text-muted-foreground"
          data-testid="wishlist-target-price-value"
        >
          <Money value={entry.targetPrice} formatters={formatters} />
        </span>
      )}

      <div className="flex items-center gap-1">
        <Button
          variant="ghost"
          onClick={onEdit}
          aria-label={`Edit ${entry.name}`}
          data-testid="wishlist-edit"
        >
          <EditIcon />
        </Button>
        <Button
          variant="ghost"
          onClick={onDelete}
          disabled={isDeleting}
          aria-label={`Remove ${entry.name} from wishlist`}
          data-testid="wishlist-delete"
        >
          <DeleteIcon className="text-glyph-danger" />
        </Button>
      </div>
    </li>
  );
}
