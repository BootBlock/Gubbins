import { MAIN_CONTENT_ID, PageContainer, PageHeader, Surface } from '@/components/foundry';
import { AchievementIcon, LockedIcon, SuccessIcon } from '@/components/icons';
import { useT } from '@/features/i18n';
import { cn } from '@/lib/utils';
import { useFormatters } from '@/lib/useFormatters';
import { useAchievementsStore } from '@/state/stores/useAchievementsStore';
import { ACHIEVEMENTS, type Achievement } from './registry';

/**
 * Achievements screen (issue #412) — every achievement Gubbins can award, earned or not.
 *
 * Gubbins already celebrated a couple of moments with a firework, but kept no record of them, so
 * there was nothing to look back at. This is that record. Locked achievements are shown too rather
 * than hidden: the description doubles as what earns it, so the screen also says what there is
 * left to do.
 *
 * The awards live on this device only (see {@link useAchievementsStore}) — they are not part of
 * the vault, and are not synced or backed up.
 */
export function AchievementsScreen() {
  const t = useT();
  const unlocked = useAchievementsStore((s) => s.unlocked);
  const earned = ACHIEVEMENTS.filter((a) => unlocked[a.id] !== undefined).length;
  const total = ACHIEVEMENTS.length;
  // Guarded against a registry that is somehow empty, so the bar can never divide by zero.
  const percent = total === 0 ? 0 : Math.round((earned / total) * 100);

  return (
    <PageContainer>
      <PageHeader icon={<AchievementIcon />} title={t('achievements.title')} />

      <main
        id={MAIN_CONTENT_ID}
        tabIndex={-1}
        className="flex flex-1 animate-rise flex-col gap-6 outline-none"
      >
        <Surface className="p-5">
          <p className="text-sm text-muted-foreground">{t('achievements.intro')}</p>
          <p className="mt-4 text-sm font-medium tabular-nums" data-testid="achievements-progress">
            {t('achievements.progress', { vars: { unlocked: earned, total } })}
          </p>
          {/* Decorative restatement of the count above, which is the accessible version. */}
          <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-muted" aria-hidden>
            <div
              className="h-full rounded-full bg-primary transition-[width] duration-500 ease-emphasized"
              style={{ width: `${percent}%` }}
            />
          </div>
        </Surface>

        <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {ACHIEVEMENTS.map((achievement) => (
            <li key={achievement.id}>
              <AchievementCard achievement={achievement} at={unlocked[achievement.id]} />
            </li>
          ))}
        </ul>
      </main>
    </PageContainer>
  );
}

interface AchievementCardProps {
  readonly achievement: Achievement;
  /**
   * When it was earned: a number of epoch ms, `null` when it was earned but the instant isn't
   * known, and `undefined` when it hasn't been earned at all. The three cases are distinct — see
   * {@link useAchievementsStore} — so this deliberately does not collapse `null` into "locked".
   */
  readonly at: number | null | undefined;
}

function AchievementCard({ achievement, at }: AchievementCardProps) {
  const t = useT();
  const fmt = useFormatters();
  const locked = at === undefined;
  const { Icon } = achievement;

  return (
    <Surface className={cn('flex h-full items-start gap-3 p-4', locked && 'opacity-60')}>
      <span
        className={cn(
          'flex size-10 shrink-0 items-center justify-center rounded-xl [&_svg]:size-5',
          locked ? 'bg-muted text-muted-foreground' : 'bg-primary/15 text-primary',
        )}
      >
        {locked ? <LockedIcon aria-hidden /> : <Icon aria-hidden />}
      </span>
      <div className="min-w-0">
        <h2 className="text-sm font-semibold">{t(achievement.titleKey)}</h2>
        <p className="mt-1 text-sm text-muted-foreground">{t(achievement.descriptionKey)}</p>
        <p
          className={cn(
            'mt-2 flex items-center gap-1.5 text-xs',
            locked ? 'text-muted-foreground' : 'text-success',
          )}
        >
          {locked ? (
            <>
              <LockedIcon className="size-3.5" aria-hidden />
              {t('achievements.locked')}
            </>
          ) : (
            <>
              <SuccessIcon className="size-3.5" aria-hidden />
              {at === null
                ? t('achievements.unlocked')
                : t('achievements.unlockedOn', { vars: { date: fmt.date(at) } })}
            </>
          )}
        </p>
      </div>
    </Surface>
  );
}
