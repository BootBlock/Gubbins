/**
 * Who made a change — the one attributive field the Activity Log never showed (issue #774).
 *
 * One component for all four surfaces that render a ledger entry (an item's Activity tab, a
 * location's History tab, and both lanes of the global Activity screen), so "who" is worded and
 * placed the same way wherever a reader meets it, rather than by four copies of a span that
 * happen to agree today.
 *
 * **Shown only while the users module is on.** With accounts off there is exactly one account,
 * so every entry names it and the line would be a column of identical text carrying nothing —
 * which is what the wiki already tells a single-person setup to expect. The attribution is still
 * *recorded*, and still travels in the activity export and the cold-storage archive, which are
 * read outside this app and cannot rely on the reader knowing whose install it was.
 */
import { useT } from '@/features/i18n';
import { useFeature } from '@/features/modules/useFeature';

/**
 * @param actorDisplayName the account's display name, or `null` when the entry's actor id
 * resolves to no account — see `ItemHistoryEntry.actorDisplayName`. A name is never invented
 * for that case: the entry says an account it cannot name, and so does the line.
 */
export function ActivityActor({ actorDisplayName }: { actorDisplayName: string | null }) {
  const usersEnabled = useFeature('users');
  const t = useT();
  if (!usersEnabled) return null;
  return (
    <span data-testid="activity-actor" className="shrink-0 text-[11px] text-muted-foreground/80">
      {actorDisplayName === null
        ? t('activity.actor.unknown')
        : t('activity.actor.by', { vars: { name: actorDisplayName } })}
    </span>
  );
}
