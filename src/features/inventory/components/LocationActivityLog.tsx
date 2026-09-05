import { Button, Spinner } from '@/components/foundry';
import { HistoryIcon } from '@/components/icons';
import { useFormatters } from '@/lib/useFormatters';
import { ActivityActor } from '@/features/activity/ActivityActor';
import { useT } from '@/features/i18n';
import { describeLocationHistoryEntry } from '../location-history-format';
import { useLocationHistory } from '../queries';

/**
 * The per-location activity record (issue #691) — the location editor's answer to "why is this
 * shelf suddenly under a different room?", mirroring an item's Activity Log.
 *
 * Deliberately simpler than {@link import('./ActivityLog').ActivityLog}. That log virtualises,
 * because an item with thousands of gauge updates is ordinary; a location records only the handful
 * of changes that reshape the hierarchy, so a plain list behind a "Load more" button is the honest
 * amount of machinery. It is still **paged**, not read whole: a shared vault re-parents and
 * re-archives over years, and a capped read presented as the whole set would be a lie about an
 * audit trail.
 *
 * Entries whose location was deleted are unreachable from here by construction — this reads one
 * live location — but they are not gone: the ledger keeps them with the name the place had, so a
 * backup, an export and a peer all still carry them (see the `location_history` schema note).
 */
export function LocationActivityLog({ locationId }: { locationId: string }) {
  const history = useLocationHistory(locationId);
  const fmt = useFormatters();
  const t = useT();

  const entries = (history.data?.pages ?? []).flatMap((page) => page.rows);

  if (history.isLoading) {
    return (
      <div className="flex justify-center py-6">
        <Spinner />
      </div>
    );
  }

  if (entries.length === 0) {
    return <p className="py-2 text-xs text-muted-foreground">{t('inventory.locationActivity.empty')}</p>;
  }

  return (
    <div className="flex flex-col gap-3">
      <ul
        data-testid="location-activity-log"
        aria-label={t('inventory.locationActivity.label')}
        className="rounded-lg border border-border bg-secondary/10"
      >
        {entries.map((entry) => {
          const view = describeLocationHistoryEntry(entry);
          return (
            <li
              key={entry.id}
              data-testid="location-activity-entry"
              className="flex items-start gap-3 border-b border-border/50 px-3 py-2 last:border-b-0"
            >
              <HistoryIcon aria-hidden="true" className="mt-0.5 size-3.5 shrink-0 text-muted-foreground/70" />
              <div className="min-w-0 flex-1">
                <span className="text-xs font-semibold">{view.label}</span>
                {view.detail ? <p className="text-xs text-muted-foreground">{view.detail}</p> : null}
              </div>
              <div className="flex shrink-0 flex-col items-end">
                <time
                  dateTime={new Date(entry.createdAt).toISOString()}
                  className="text-[11px] text-muted-foreground/80"
                >
                  {fmt.dateTime(entry.createdAt)}
                </time>
                <ActivityActor actorDisplayName={entry.actorDisplayName} />
              </div>
            </li>
          );
        })}
      </ul>

      {history.hasNextPage ? (
        <div className="flex justify-center">
          <Button
            variant="outline"
            size="sm"
            onClick={() => void history.fetchNextPage()}
            disabled={history.isFetchingNextPage}
            data-testid="location-activity-load-more"
          >
            {history.isFetchingNextPage ? <Spinner /> : null}
            {t('inventory.locationActivity.loadMore')}
          </Button>
        </div>
      ) : null}
    </div>
  );
}
