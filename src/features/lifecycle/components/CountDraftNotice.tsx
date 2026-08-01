/**
 * The "your earlier counts are back" notice (issue #587), shared by the standalone cycle-count
 * dialog and the guided stock-take's per-location panel.
 *
 * A count sheet that silently repopulates itself would be its own kind of dishonesty: the
 * auditor has to know these are *their* numbers from a previous sitting rather than something
 * Gubbins filled in, and roughly how stale they are, before authorising a variance against
 * them. So the notice names what came back and when, and offers to throw it away and count the
 * location from scratch.
 *
 * The live region is always mounted (empty on a fresh count) and sits outside the caller's
 * loading / empty / counting branches: a `role="status"` element inserted at the same moment as
 * its text is frequently never announced — see the `LiveRegion` primitive's own note.
 */
import { Button, LiveRegion, Tooltip } from '@/components/foundry';
import { HistoryIcon } from '@/components/icons';
import { plural } from '@/lib/plural';
import { useFormatters } from '@/lib/useFormatters';
import type { RestoredCount } from '../CycleCountContext';

export function CountDraftNotice({
  restored,
  onDiscard,
}: {
  restored: RestoredCount | null;
  onDiscard: () => void;
}) {
  const fmt = useFormatters();

  // "…entered here 2 days ago". Under a minute is said as "just now" rather than passed to the
  // relative formatter, whose "now" reads as a broken sentence in this position; and a sheet whose
  // stored stamp was unusable says "earlier" — a fabricated date is worse than none on something
  // the auditor is being asked to judge.
  const savedAt = restored?.savedAt ?? null;
  const when =
    savedAt === null ? 'earlier' : Date.now() - savedAt < 60_000 ? 'just now' : fmt.relativeTime(savedAt);
  const message = restored
    ? `Restored ${restored.entries} ${plural(restored.entries, 'count')} entered here ${when}.`
    : '';

  return (
    <>
      <LiveRegion visuallyHidden data-testid="count-draft-live">
        {message ? <p>{message}</p> : null}
      </LiveRegion>

      {restored ? (
        <div
          className="mb-4 flex items-start gap-3 rounded-lg border border-border bg-muted/30 p-3 text-sm text-muted-foreground"
          data-testid="count-draft-notice"
        >
          <HistoryIcon className="mt-0.5 size-4 shrink-0" aria-hidden />
          <p className="min-w-0 flex-1">
            <span className="font-medium text-foreground">Picked up where you left off.</span> {message} Check
            the sheet still matches the shelf before authorising.
          </p>
          <Tooltip
            content="Clear the restored counts and count this location from scratch. Nothing has been written to the ledger yet, so this only discards the unfinished sheet."
            triggerTabIndex={-1}
          >
            <span>
              <Button variant="ghost" size="sm" onClick={onDiscard} data-testid="count-draft-discard">
                Start over
              </Button>
            </span>
          </Tooltip>
        </div>
      ) : null}
    </>
  );
}
