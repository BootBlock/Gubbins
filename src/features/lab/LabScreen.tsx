/**
 * LabScreen — the hidden testing screen (`/lab`).
 *
 * Not linked from anywhere: it is absent from the global nav, the command palette and the wiki,
 * and is reached only by typing its URL. That is deliberate — it exists so behaviour that is
 * normally decided *for* you can be driven on demand, which is useful during development and
 * confusing on a shelf beside real settings.
 *
 * The screen is registry-driven so future switches cost one entry rather than a new screen:
 * {@link OCCASIONS} render as three-way garnish gates and {@link LAB_FLAGS} as grouped on/off
 * rows. Three things sit outside that pattern because they are not booleans — the **date override**,
 * which shifts what the whole app considers "today"; the **effects** section, which plays a one-off
 * animation on demand rather than storing anything; and the **actions** section, which is separated
 * and confirmation-gated precisely because (unlike every switch above it) it writes to the user's
 * real data.
 */
import { useMemo, useState } from 'react';
import {
  Button,
  FormField,
  Input,
  Modal,
  PageContainer,
  PageHeader,
  Select,
  SelectField,
  Surface,
  MAIN_CONTENT_ID,
  useBurst,
} from '@/components/foundry';
import { useDecorationFlourishReduced } from '@/components/foundry/decoration-motion';
import { CelebrateIcon, LabIcon, ResetIcon, WarningIcon } from '@/components/icons';
import { OCCASIONS, resolveOccasion, type OccasionMode } from '@/components/background/seasonal';
import { useT } from '@/features/i18n';
import { nowDate } from '@/lib/clock';
import { getItemRepository } from '@/db/repositories';
import { usePreferencesStore } from '@/state/stores/usePreferencesStore';
import { useLabFlag, useLabStore } from '@/state/stores/useLabStore';
import { LAB_FLAGS, LAB_FLAG_GROUPS } from './lab-flags';
import { buildSeedItems, SEED_COUNTS } from './seed-data';

/** How the seed action is progressing, so the row can report itself without a toast system. */
type SeedState = { status: 'idle' | 'working' | 'done' | 'failed'; count: number };

export function LabScreen() {
  const t = useT();
  const dateOverride = useLabStore((s) => s.dateOverride);
  const occasionModes = useLabStore((s) => s.occasionModes);
  const flags = useLabStore((s) => s.flags);
  const setDateOverride = useLabStore((s) => s.setDateOverride);
  const setOccasionMode = useLabStore((s) => s.setOccasionMode);
  const setFlag = useLabStore((s) => s.setFlag);
  const resetLab = useLabStore((s) => s.resetLab);
  const backgroundEffect = usePreferencesStore((s) => s.backgroundEffect);
  const ignoreEffect = useLabFlag('seasonal-ignore-effect');

  // Resolved against the *shifted* clock, so the reported occasion matches what the background
  // layer will actually draw once a date override is set. Deliberately not memoised: the result
  // depends on `nowDate()` as much as on the overrides, and a dependency list can't express that
  // honestly — while the work itself is a loop over eight occasions, so there is nothing to save.
  const active = resolveOccasion(nowDate(), occasionModes);

  // `t` is memoised per language, so the option lists are rebuilt only when the language changes
  // rather than handing every Select a fresh array on each render.
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

        <DateOverrideSection value={dateOverride} onChange={setDateOverride} />

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
          {LAB_FLAG_GROUPS.map((group) => {
            const groupFlags = LAB_FLAGS.filter((flag) => flag.group === group.id);
            if (groupFlags.length === 0) return null;
            return (
              <section key={group.id} className="mt-5 first:mt-4">
                <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  {t(group.labelKey)}
                </h3>
                <ul className="mt-2 divide-y divide-border">
                  {groupFlags.map((flag) => {
                    const label = t(flag.labelKey);
                    return (
                      <li
                        key={flag.id}
                        className="flex flex-wrap items-center justify-between gap-3 py-3 last:pb-0"
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
              </section>
            );
          })}
        </Surface>

        <BurstSection />

        <SeedSection />
      </main>
    </PageContainer>
  );
}

/** The date override: a plain date field plus a "back to the real date" escape. */
function DateOverrideSection({
  value,
  onChange,
}: {
  readonly value: string | null;
  readonly onChange: (isoDate: string | null) => void;
}) {
  const t = useT();
  return (
    <Surface className="p-5" aria-labelledby="lab-date-heading">
      <h2 id="lab-date-heading" className="text-sm font-semibold text-foreground">
        {t('lab.date.heading')}
      </h2>
      <p className="mt-1 text-xs text-muted-foreground">{t('lab.date.intro')}</p>
      <div className="mt-4 flex flex-wrap items-end gap-3">
        <FormField label={t('lab.date.label')} className="w-52">
          <Input
            type="date"
            data-testid="lab-date-input"
            value={value ?? ''}
            onChange={(event) => onChange(event.target.value || null)}
          />
        </FormField>
        <Button
          variant="outline"
          size="sm"
          data-testid="lab-date-clear"
          disabled={value === null}
          onClick={() => onChange(null)}
        >
          {t('lab.date.clear')}
        </Button>
      </div>
      <p className="mt-3 text-xs text-muted-foreground" role="status" data-testid="lab-date-status">
        {value ? t('lab.date.active', { vars: { date: value } }) : t('lab.date.real')}
      </p>
    </Surface>
  );
}

/**
 * The effects section: play a one-off effect on demand rather than waiting for the milestone that
 * normally fires it (the first item ever added, a completed stock-take), which is otherwise a
 * once-per-device moment and awkward to see again.
 *
 * It reads the same flourish gate the burst itself does, so when the effect *can't* play — the
 * animation level is below the maximal tier, or the device prefers reduced motion — the row says
 * so up front instead of leaving a button that silently does nothing.
 */
function BurstSection() {
  const t = useT();
  const { burst } = useBurst();
  const suppressed = useDecorationFlourishReduced();
  const [fired, setFired] = useState(false);

  return (
    <Surface className="p-5" aria-labelledby="lab-burst-heading">
      <h2 id="lab-burst-heading" className="text-sm font-semibold text-foreground">
        {t('lab.burst.heading')}
      </h2>
      <p className="mt-1 text-xs text-muted-foreground">{t('lab.burst.intro')}</p>

      <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="text-sm font-medium text-foreground">{t('lab.burst.label')}</div>
          <p className="text-xs text-muted-foreground">{t('lab.burst.description')}</p>
        </div>
        <Button
          variant="outline"
          data-testid="lab-burst-fire"
          onClick={() => {
            burst();
            setFired(true);
          }}
        >
          <CelebrateIcon aria-hidden />
          {t('lab.burst.action')}
        </Button>
      </div>

      <p className="mt-3 text-xs text-muted-foreground" role="status" data-testid="lab-burst-status">
        {suppressed ? t('lab.burst.suppressed') : fired ? t('lab.burst.fired') : null}
      </p>
    </Surface>
  );
}

/**
 * The actions section. Deliberately last, visually separated and confirmation-gated: everything
 * above it is a reversible presentation switch, while this writes rows into the user's inventory
 * that clearing browser storage will not remove.
 */
function SeedSection() {
  const t = useT();
  const [count, setCount] = useState<number>(SEED_COUNTS[0]);
  const [confirming, setConfirming] = useState(false);
  const [seed, setSeed] = useState<SeedState>({ status: 'idle', count: 0 });

  const countOptions = useMemo(() => SEED_COUNTS.map((n) => ({ value: String(n), label: String(n) })), []);

  const runSeed = async () => {
    setConfirming(false);
    setSeed({ status: 'working', count });
    try {
      await getItemRepository().createMany(buildSeedItems(count));
      setSeed({ status: 'done', count });
    } catch {
      // The concrete failure isn't actionable here (a full disk, a closed database); the row just
      // reports that nothing was added so the operator can retry or investigate.
      setSeed({ status: 'failed', count });
    }
  };

  return (
    <Surface className="border-destructive/40 p-5" aria-labelledby="lab-actions-heading">
      <h2 id="lab-actions-heading" className="flex items-center gap-2 text-sm font-semibold text-foreground">
        <WarningIcon aria-hidden className="size-4 text-warning" />
        {t('lab.actions.heading')}
      </h2>
      <p className="mt-1 text-xs text-muted-foreground">{t('lab.actions.intro')}</p>

      <div className="mt-4 flex flex-wrap items-end justify-between gap-3">
        <div className="min-w-0">
          <div className="text-sm font-medium text-foreground">{t('lab.seed.label')}</div>
          <p className="text-xs text-muted-foreground">{t('lab.seed.description')}</p>
        </div>
        <div className="flex items-end gap-3">
          <SelectField
            label={t('lab.seed.count')}
            data-testid="lab-seed-count"
            className="w-32"
            value={String(count)}
            onChange={(value) => setCount(Number(value))}
            options={countOptions}
          />
          <Button
            variant="destructive"
            data-testid="lab-seed-start"
            disabled={seed.status === 'working'}
            onClick={() => setConfirming(true)}
          >
            {t('lab.seed.action')}
          </Button>
        </div>
      </div>

      {seed.status !== 'idle' ? (
        <p className="mt-3 text-xs text-muted-foreground" role="status" data-testid="lab-seed-status">
          {seed.status === 'working' ? t('lab.seed.working') : null}
          {seed.status === 'done' ? t('lab.seed.done', { vars: { count: seed.count } }) : null}
          {seed.status === 'failed' ? t('lab.seed.failed') : null}
        </p>
      ) : null}

      {confirming ? (
        <Modal
          open
          onClose={() => setConfirming(false)}
          title={t('lab.seed.confirmTitle', { vars: { count } })}
        >
          <p className="text-sm text-muted-foreground">{t('lab.seed.confirmBody', { vars: { count } })}</p>
          <div className="mt-5 flex justify-end gap-2">
            <Button variant="outline" onClick={() => setConfirming(false)}>
              {t('lab.seed.cancel')}
            </Button>
            <Button variant="destructive" data-testid="lab-seed-confirm-action" onClick={runSeed}>
              {t('lab.seed.confirmAction')}
            </Button>
          </div>
        </Modal>
      ) : null}
    </Surface>
  );
}
