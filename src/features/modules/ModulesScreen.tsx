import { useMemo, useState } from 'react';
import {
  Button,
  Input,
  PageContainer,
  PageHeader,
  Select,
  Surface,
  MAIN_CONTENT_ID,
  optionCardClassName,
} from '@/components/foundry';
import { CheckIcon, ModulesIcon, ResetIcon, SearchIcon } from '@/components/icons';
import { cn } from '@/lib/utils';
import { useModulesStore } from '@/state/stores/useModulesStore';
import {
  FEATURE_GROUP_ORDER,
  FEATURE_REGISTRY,
  OPTIONAL_FEATURE_IDS,
  getFeature,
  type FeatureDef,
  type FeatureGroup,
  type FeatureId,
} from './feature-registry';
import { closureToDisable, closureToEnable, resolveEnabled } from './modules-graph';
import { ConfirmCascadeModal, type PendingCascade } from './ConfirmCascadeModal';
import { FirstRunModulesDialog } from './FirstRunModules';
import { PRESETS, type PresetId } from './presets';

/** On/off pair for the per-feature {@link Select} toggles (On listed first). */
const ON_OFF_OPTIONS = [
  { value: 'on', label: 'On' },
  { value: 'off', label: 'Off' },
] as const;

/** Human heading + one-line intro per feature group (the SSOT keys are terse). */
const GROUP_META: Record<FeatureGroup, { readonly label: string; readonly description: string }> = {
  core: { label: 'Core', description: 'The essentials — always available and never hidden.' },
  pages: { label: 'Pages', description: 'Top-level screens you can add to or remove from the app.' },
  capabilities: {
    label: 'Capabilities',
    description: 'Cross-cutting features woven through your items and dashboard.',
  },
  integrations: { label: 'Integrations', description: 'Optional connections to other systems.' },
};

/**
 * A canonical key for a resolved enabled set — the optional feature ids that are on, in
 * registry order. Used to spot which preset (if any) the current configuration matches, so
 * the manager can highlight it. Core ids are omitted (always on, so never distinguishing).
 */
function enabledOptionalKey(enabled: ReadonlySet<FeatureId>): string {
  return OPTIONAL_FEATURE_IDS.filter((id) => enabled.has(id)).join(',');
}

/**
 * The resolved enabled-key each preset produces, computed once. Comparing the live
 * configuration's key against these tells the manager which preset card to mark active
 * (the default everything-on state matches `everything`).
 */
const PRESET_ENABLED_KEYS: ReadonlyArray<readonly [PresetId, string]> = PRESETS.map((preset) => {
  const intent = Object.fromEntries(OPTIONAL_FEATURE_IDS.map((id) => [id, preset.featureIds.includes(id)]));
  return [preset.id, enabledOptionalKey(resolveEnabled(intent, FEATURE_REGISTRY))] as const;
});

/**
 * Modules manager screen (modular-ui-plan §4, Phase 3).
 *
 * The first-class home for the Modular UI: curated presets, a searchable granular toggle
 * list grouped by feature group, and clear dependency messaging. Toggling a feature off
 * that other features depend on — or on when it needs others that are off — opens a
 * confirmation listing the knock-on changes; only then is the intent mutated. Everything
 * reflects live: applying a preset immediately updates the toggles below it. Reached from
 * Settings, the first-run chooser and the "module hidden" interstitial (it is deliberately
 * not a global-nav destination). Intent is device-local via {@link useModulesStore}; the
 * effective set is resolved by the pure `resolveEnabled` engine.
 */
export function ModulesScreen() {
  const intent = useModulesStore((state) => state.intent);
  const setFeatureIntent = useModulesStore((state) => state.setFeatureIntent);
  const applyPreset = useModulesStore((state) => state.applyPreset);

  const enabled = useMemo(() => resolveEnabled(intent, FEATURE_REGISTRY), [intent]);
  const activePresetId = useMemo(() => {
    const key = enabledOptionalKey(enabled);
    return PRESET_ENABLED_KEYS.find(([, presetKey]) => presetKey === key)?.[0] ?? null;
  }, [enabled]);

  const [query, setQuery] = useState('');
  const [pending, setPending] = useState<PendingCascade | null>(null);
  // Re-run the first-run chooser on demand via local mount state — flipping the persisted
  // `firstRunComplete` flag back off would wrongly re-trigger the wizard on every load.
  const [showChooser, setShowChooser] = useState(false);

  const trimmedQuery = query.trim().toLowerCase();
  const matchesQuery = (feature: FeatureDef) =>
    trimmedQuery.length === 0 ||
    feature.label.toLowerCase().includes(trimmedQuery) ||
    feature.description.toLowerCase().includes(trimmedQuery);

  /** Set every id in the list on (used for an enable + its pulled-in dependencies). */
  const enableAll = (ids: readonly FeatureId[]) => {
    for (const id of ids) setFeatureIntent(id, true);
  };

  /**
   * Handle a toggle. When the change would cascade to other effective features (dependents
   * on the way off, or off dependencies on the way on) we stage it and open a confirmation;
   * a self-contained change (closure is just the feature itself) applies immediately.
   */
  const requestToggle = (id: FeatureId, nextOn: boolean) => {
    const closure = [
      ...(nextOn
        ? closureToEnable(id, intent, FEATURE_REGISTRY)
        : closureToDisable(id, intent, FEATURE_REGISTRY)),
    ];
    const hasExtras = closure.some((other) => other !== id);
    if (!hasExtras) {
      setFeatureIntent(id, nextOn);
      return;
    }
    setPending({ action: nextOn ? 'enable' : 'disable', id, closure });
  };

  const confirmPending = () => {
    if (!pending) return;
    // Disabling only records the toggled feature's intent — resolution cascades the
    // dependents off (and re-enabling later restores them to their own intent). Enabling
    // must switch every pulled-in dependency on, or the feature would still resolve off.
    if (pending.action === 'enable') enableAll(pending.closure);
    else setFeatureIntent(pending.id, false);
    setPending(null);
  };

  const anyMatches = FEATURE_REGISTRY.some(matchesQuery);

  return (
    <PageContainer>
      <PageHeader icon={<ModulesIcon />} title="Modules" />

      <main
        id={MAIN_CONTENT_ID}
        tabIndex={-1}
        className="flex flex-1 animate-rise flex-col gap-6 outline-none"
      >
        <p className="max-w-2xl text-sm text-muted-foreground">
          Tailor Gubbins to how you work. Switch off pages and capabilities you don’t use for a leaner app —
          everything stays fully functional underneath and can be switched back on at any time.
        </p>

        <section aria-labelledby="modules-presets-heading" className="flex flex-col gap-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 id="modules-presets-heading" className="text-sm font-semibold text-foreground">
              Presets
            </h2>
            <Button
              variant="outline"
              size="sm"
              data-testid="modules-run-setup-again"
              onClick={() => setShowChooser(true)}
            >
              <ResetIcon aria-hidden />
              Run setup again
            </Button>
          </div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {PRESETS.map((preset) => {
              const active = preset.id === activePresetId;
              return (
                <button
                  key={preset.id}
                  type="button"
                  aria-pressed={active}
                  data-testid={`preset-${preset.id}`}
                  onClick={() => applyPreset(preset.id)}
                  className={cn('flex flex-col gap-1.5 [&_svg]:size-4', optionCardClassName(active))}
                >
                  <span className="flex items-center gap-2 text-sm font-medium text-foreground">
                    <preset.Icon aria-hidden />
                    <span className="min-w-0 flex-1">{preset.label}</span>
                    {active ? (
                      <CheckIcon
                        aria-hidden
                        className="text-primary"
                        data-testid={`preset-${preset.id}-active`}
                      />
                    ) : null}
                  </span>
                  <span className="text-xs text-muted-foreground">{preset.description}</span>
                </button>
              );
            })}
          </div>
        </section>

        <div className="relative max-w-md">
          <SearchIcon
            aria-hidden
            className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
          />
          <Input
            aria-label="Search modules"
            data-testid="modules-search"
            type="search"
            placeholder="Search modules…"
            className="pl-9"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </div>

        {FEATURE_GROUP_ORDER.map((group) => {
          const features = FEATURE_REGISTRY.filter(
            (feature) => feature.group === group && matchesQuery(feature),
          );
          if (features.length === 0) return null;
          const meta = GROUP_META[group];
          return (
            <Surface key={group} role="group" className="p-5" aria-labelledby={`modules-group-${group}`}>
              <div>
                <h2 id={`modules-group-${group}`} className="text-sm font-semibold text-foreground">
                  {meta.label}
                </h2>
                <p className="text-xs text-muted-foreground">{meta.description}</p>
              </div>
              <ul className="mt-4 divide-y divide-border">
                {features.map((feature) => (
                  <FeatureRow
                    key={feature.id}
                    feature={feature}
                    on={enabled.has(feature.id)}
                    onChange={(nextOn) => requestToggle(feature.id, nextOn)}
                  />
                ))}
              </ul>
            </Surface>
          );
        })}

        {!anyMatches ? (
          <p className="text-sm text-muted-foreground" role="status" data-testid="modules-no-results">
            No modules match “{query.trim()}”.
          </p>
        ) : null}
      </main>

      {pending ? (
        <ConfirmCascadeModal pending={pending} onCancel={() => setPending(null)} onConfirm={confirmPending} />
      ) : null}

      {showChooser ? <FirstRunModulesDialog onClose={() => setShowChooser(false)} /> : null}
    </PageContainer>
  );
}

/** One feature's row: icon, label, description, dependency note, and its on/off control. */
function FeatureRow({
  feature,
  on,
  onChange,
}: {
  readonly feature: FeatureDef;
  readonly on: boolean;
  readonly onChange: (nextOn: boolean) => void;
}) {
  const requires =
    feature.dependsOn && feature.dependsOn.length > 0
      ? feature.dependsOn.map((id) => getFeature(id)?.label ?? id).join(', ')
      : null;

  return (
    <li className="flex flex-wrap items-center justify-between gap-3 py-3 first:pt-0 last:pb-0">
      <div className="flex min-w-0 items-start gap-3">
        <feature.Icon aria-hidden className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
        <div className="min-w-0">
          <div className="text-sm font-medium text-foreground">{feature.label}</div>
          <p className="text-xs text-muted-foreground">{feature.description}</p>
          {requires ? <p className="text-xs text-muted-foreground">Requires: {requires}</p> : null}
        </div>
      </div>
      <div className="shrink-0">
        {feature.alwaysOn ? (
          <span
            className="inline-flex h-10 items-center gap-1.5 rounded-lg px-3 text-sm text-muted-foreground"
            data-testid={`module-locked-${feature.id}`}
          >
            <CheckIcon aria-hidden className="size-4" />
            Always on
          </span>
        ) : (
          <Select
            aria-label={`${feature.label} module`}
            data-testid={`module-toggle-${feature.id}`}
            className="h-10 w-28"
            value={on ? 'on' : 'off'}
            onChange={(value) => onChange(value === 'on')}
            options={ON_OFF_OPTIONS}
          />
        )}
      </div>
    </li>
  );
}
