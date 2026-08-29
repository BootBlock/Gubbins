/**
 * useUnlockAchievement — the one way an achievement is awarded (issue #412).
 *
 * Awarding has three parts that must not drift apart: the durable record, the success burst and
 * the toast that carries the moment as *text* for a screen-reader user (the burst is decorative
 * and `aria-hidden`, and is nothing at all under reduced motion). Every call site gets all three
 * from here rather than composing them itself.
 *
 * The two options exist because not every award is a moment:
 *  - `celebrate: false` records an achievement that was already true the first time Gubbins
 *    looked — an inventory that held two hundred items before this screen existed. There is
 *    nothing to congratulate anyone for having done a year ago, so it lands silently and with a
 *    `null` instant (see {@link useAchievementsStore}).
 *  - `burst: false` suppresses only the firework, for a call site that already fires its own on
 *    the same event. The stock-take and location-count dialogs burst on *every* completion, not
 *    just the first, so letting this fire a second one would double up the very first time.
 */
import { createElement, useCallback } from 'react';
import { useBurst, useOptionalToast } from '@/components/foundry';
import { AchievementIcon } from '@/components/icons';
import { useT } from '@/features/i18n';
import { useAchievementsStore } from '@/state/stores/useAchievementsStore';
import { ACHIEVEMENTS, type AchievementId } from './registry';

export interface UnlockOptions {
  /** Announce it with a toast (and, unless `burst` says otherwise, a burst). Default `true`. */
  readonly celebrate?: boolean;
  /** Fire the success burst. Defaults to whatever `celebrate` resolves to. */
  readonly burst?: boolean;
}

export type UnlockAchievement = (id: AchievementId, options?: UnlockOptions) => void;

export function useUnlockAchievement(): UnlockAchievement {
  const unlock = useAchievementsStore((s) => s.unlock);
  const { burst } = useBurst();
  // Optional, like `useBurst`: this hook *notifies*, and it is called from dialogs whose own job
  // is counting stock. A harness that renders one without the provider must still be able to
  // record the achievement rather than throw on the way past.
  const toast = useOptionalToast();
  const t = useT();

  return useCallback(
    (id, options) => {
      const achievement = ACHIEVEMENTS.find((a) => a.id === id);
      if (!achievement) return;
      const celebrate = options?.celebrate ?? true;
      // Read through `getState` rather than subscribing: this callback would otherwise change
      // identity on every award, re-running the effects that depend on it.
      if (useAchievementsStore.getState().unlocked[id] !== undefined) return;

      unlock(id, celebrate ? Date.now() : null);
      if (!celebrate) return;

      if (options?.burst ?? true) burst();
      toast?.show({
        tone: 'success',
        icon: createElement(AchievementIcon, { 'aria-hidden': true }),
        heading: t('achievements.toast.heading', { vars: { title: t(achievement.titleKey) } }),
        message: t(achievement.descriptionKey),
      });
    },
    [unlock, burst, toast, t],
  );
}
