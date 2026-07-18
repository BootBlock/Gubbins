/**
 * LabScreen — the hidden testing screen (`/lab`).
 *
 * Not linked from anywhere: it is absent from the global nav, the command palette and the wiki,
 * and is reached only by typing its URL. That is deliberate — it exists so behaviour that is
 * normally decided *for* you can be driven on demand, which is useful during development and
 * confusing on a shelf beside real settings.
 *
 * The screen is generic on purpose, so future switches cost one registry entry rather than a new
 * screen: it renders {@link OCCASIONS} as three-way garnish gates and {@link LAB_FLAGS} as plain
 * on/off rows, both stored by id in {@link useLabStore}. Nothing here touches the database; every
 * override is device-local and reversible with **Reset everything**.
 */
import { useMemo } from 'react';
import { Button, PageContainer, PageHeader, Select, Surface, MAIN_CONTENT_ID } from '@/components/foundry';
import { LabIcon, ResetIcon } from '@/components/icons';
import { OCCASIONS, resolveOccasion, type OccasionMode } from '@/components/background/seasonal';
import { useT } from '@/features/i18n';
import { usePreferencesStore } from '@/state/stores/usePreferencesStore';
import { useLabFlag, useLabStore } from '@/state/stores/useLabStore';
import { LAB_FLAGS } from './lab-flags';

export function LabScreen() {
  const t = useT();
  const occasionModes = useLabStore((s) => s.occasionModes);
  const flags = useLabStore((s) => s.flags);
  const setOccasionMode = useLabStore((s) => s.setOccasionMode);
  const setFlag = useLabStore((s) => s.setFlag);
  const resetLab = useLabStore((s) => s.resetLab);
  const backgroundEffect = usePreferencesStore((s) => s.backgroundEffect);
  const ignoreEffect = useLabFlag('seasonal-ignore-effect');

  // The same resolution the background layer runs, so the screen reports what is actually falling
  // rather than a second opinion that could drift from it.
  const active = useMemo(() => resolveOccasion(new Date(), occasionModes), [occasionModes]);

  // `t` is memoised per language, so the option lists are rebuilt only when the language changes
  // rather than handing all ten Selects a fresh array on every render.
  const modeOptions = useMemo(
    () => [
      { value: 'auto', label: t('lab.mode.auto') },
      { value: 'on', label: t('lab.mode.on') },
      { value: 'off', label: t('lab.mode.off') },
    ],
    [t],
  );
  const onOffOptions = useMemo(
    () => [
      { value: 'on', label: t('lab.toggle.on') },
      { value: 'off', label: t('lab.toggle.off') },
    ],
    [t],
  );

  // A forced occasion still shows nothing unless something is falling for it to ride — surface
  // that here rather than leaving the switch looking broken.
  const needsEffect = active !== null && backgroundEffect === 'none' && !ignoreEffect;

  return (
    <PageContainer>
      <PageHeader icon={<LabIcon />} title={t('lab.title')} />

      <main
        id={MAIN_CONTENT_ID}
        tabIndex={-1}
        className="flex flex-1 animate-rise flex-col gap-6 outline-none"
      >
        <div className="flex flex-wrap items-start justify-between gap-3">
          <p className="max-w-2xl text-sm text-muted-foreground">{t('lab.intro')}</p>
          <Button variant="outline" size="sm" data-testid="lab-reset" onClick={resetLab}>
            <ResetIcon aria-hidden />
            {t('lab.reset')}
          </Button>
        </div>

        <Surface className="p-5" aria-labelledby="lab-seasonal-heading">
          <h2 id="lab-seasonal-heading" className="text-sm font-semibold text-foreground">
            {t('lab.seasonal.heading')}
          </h2>
          <p className="mt-1 text-xs text-muted-foreground">{t('lab.seasonal.intro')}</p>
          <p className="mt-2 text-xs text-muted-foreground" role="status" data-testid="lab-seasonal-status">
            {active
              ? t('lab.seasonal.active', { vars: { occasion: t(active.labelKey) } })
              : t('lab.seasonal.none')}
            {needsEffect ? ` ${t('lab.seasonal.needsEffect')}` : ''}
          </p>

          <ul className="mt-4 divide-y divide-border">
            {OCCASIONS.map((occasion) => {
              const label = t(occasion.labelKey);
              return (
                <li
                  key={occasion.id}
                  className="flex flex-wrap items-center justify-between gap-3 py-3 first:pt-0 last:pb-0"
                >
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 text-sm font-medium text-foreground">
                      <span>{label}</span>
                      {/* Decorative preview of the sprite set — the row is already named by its label. */}
                      <span aria-hidden className="text-base leading-none">
                        {occasion.emoji.join(' ')}
                      </span>
                    </div>
                    <p className="text-xs text-muted-foreground">{t(occasion.windowKey)}</p>
                  </div>
                  <Select
                    aria-label={t('lab.seasonal.modeLabel', { vars: { occasion: label } })}
                    data-testid={`lab-occasion-${occasion.id}`}
                    className="h-10 w-36 shrink-0"
                    value={occasionModes[occasion.id] ?? 'auto'}
                    onChange={(value) => setOccasionMode(occasion.id, value as OccasionMode)}
                    options={modeOptions}
                  />
                </li>
              );
            })}
          </ul>
        </Surface>

        <Surface className="p-5" aria-labelledby="lab-flags-heading">
          <h2 id="lab-flags-heading" className="text-sm font-semibold text-foreground">
            {t('lab.flags.heading')}
          </h2>
          <p className="mt-1 text-xs text-muted-foreground">{t('lab.flags.intro')}</p>
          <ul className="mt-4 divide-y divide-border">
            {LAB_FLAGS.map((flag) => {
              const label = t(flag.labelKey);
              return (
                <li
                  key={flag.id}
                  className="flex flex-wrap items-center justify-between gap-3 py-3 first:pt-0 last:pb-0"
                >
                  <div className="min-w-0">
                    <div className="text-sm font-medium text-foreground">{label}</div>
                    <p className="text-xs text-muted-foreground">{t(flag.descriptionKey)}</p>
                  </div>
                  <Select
                    aria-label={label}
                    data-testid={`lab-flag-${flag.id}`}
                    className="h-10 w-28 shrink-0"
                    value={flags[flag.id] ? 'on' : 'off'}
                    onChange={(value) => setFlag(flag.id, value === 'on')}
                    options={onOffOptions}
                  />
                </li>
              );
            })}
          </ul>
        </Surface>
      </main>
    </PageContainer>
  );
}
