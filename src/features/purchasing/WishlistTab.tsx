/**
 * Wishlist tab (feature-gap G8 — manual "to-buy" / wishlist).
 *
 * A manual list of **wanted-but-not-owned** things to buy — the counterpart to the *stock-driven*
 * Reorder / Shopping-list tab. Each entry is free-standing (a name plus an optional note, link,
 * target price and priority), added/edited via {@link WishlistEntryDialog} and removed inline.
 * All ordering/summarising lives in the pure `wishlist.ts` seam; this is glue. Design tokens +
 * Foundry primitives + WCAG 4.1.3 live regions throughout (CLAUDE.md).
 */
import { useMemo, useState } from 'react';
import { Button, LiveRegion, Money, Spinner, Surface } from '@/components/foundry';
import { AddIcon, DeleteIcon, EditIcon, ExternalLinkIcon, WishlistIcon } from '@/components/icons';
import { plural } from '@/lib/plural';
import { useFormatters } from '@/lib/useFormatters';
import type { WishlistEntry } from '@/db/repositories';
import { WISHLIST_PRIORITY_LABELS, summariseWishlist, type WishlistPriority } from './wishlist';
import {
  useCreateWishlistEntry,
  useDeleteWishlistEntry,
  useUpdateWishlistEntry,
  useWishlist,
} from './wishlist-queries';
import { WishlistEntryDialog } from './components/WishlistEntryDialog';

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
  const [editing, setEditing] = useState<WishlistEntry | null>(null);

  const entries = useMemo(() => listQuery.data?.rows ?? [], [listQuery.data]);
  const summary = useMemo(() => summariseWishlist(entries), [entries]);

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
        <Button variant="primary" onClick={openAdd} data-testid="wishlist-add">
          <AddIcon />
          Add wish
        </Button>
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
        <Surface className="overflow-hidden p-0">
          {/* eslint-disable-next-line jsx-a11y/no-redundant-roles -- flex layout drops the <ul>'s implicit list semantics in Safari/VoiceOver, so role="list" is restored deliberately. */}
          <ul className="flex flex-col divide-y divide-border" role="list">
            {entries.map((entry) => (
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
