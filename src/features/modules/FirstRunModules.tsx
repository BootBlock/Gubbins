/**
 * First-run setup wizard (modular-ui-plan §4, Phase 8; animation level added later).
 *
 * A skippable one-time, two-step wizard shown once at the app root when the modules first-run flow
 * has not been completed (see {@link FirstRunModules}). It never re-shows once dismissed because
 * every exit — finishing, skipping, or dismissing via Escape/backdrop/Close — sets
 * `firstRunComplete`.
 *
 * - **Step 1 — Modules.** The curated {@link PRESETS} as a single-select radiogroup of cards.
 * - **Step 2 — Animation.** How visually animated the interface should be ({@link ANIMATION_LEVELS},
 *   liveliest → calmest). Applied live to the preference store as it is picked (so the choice is
 *   previewed behind the dialog), exactly as the Settings → Appearance control writes it.
 *
 * Terminal choices:
 * - **Use this setup** (step 2) applies the selected modules preset (`applyPreset`) then completes.
 * - **Skip** / any dismiss completes *without* touching module intent (everything stays on — today's
 *   default). A live-previewed animation level is left as picked (it is a plain preference, and the
 *   `full` default means an untouched flow changes nothing).
 *
 * The same dialog is re-opened from the Modules manager's "Run setup again" action via
 * {@link FirstRunModulesDialog} with local mount state, so re-running never relies on
 * un-persisting the completion flag.
 */
import { useEffect, useRef, useState, type ComponentType, type RefObject, type SVGProps } from 'react';
import { useRouterState } from '@tanstack/react-router';
import { Button, Modal, useRovingRadioGroup } from '@/components/foundry';
import { CheckIcon } from '@/components/icons';
import { cn } from '@/lib/utils';
import { useModulesStore } from '@/state/stores/useModulesStore';
import { usePreferencesStore } from '@/state/stores/usePreferencesStore';
import { ANIMATION_LEVELS, type AnimationLevel } from '@/features/settings/theme-registry';
import { presetCardClassName } from './preset-card';
import { PRESETS, type PresetId } from './presets';

/**
 * Root-mounted gate for the first-run wizard. Renders the dialog once, on any route, while the
 * first-run flow is outstanding — except on the `/modules` manager itself, where the same choice is
 * already front-and-centre (and its "Run setup again" hosts the dialog), so stacking the wizard on
 * top would be redundant.
 */
export function FirstRunModules() {
  const firstRunComplete = useModulesStore((state) => state.firstRunComplete);
  const onModulesScreen = useRouterState({ select: (state) => state.location.pathname === '/modules' });

  if (firstRunComplete || onModulesScreen) return null;
  // Dismissing at the root simply completes the flow; the flag flip unmounts this.
  return <FirstRunModulesDialog onClose={() => {}} />;
}

/** A selectable option shown as a card in a wizard step. `Icon` is optional (levels have none). */
interface Choice {
  readonly id: string;
  readonly label: string;
  readonly description: string;
  readonly Icon?: ComponentType<SVGProps<SVGSVGElement>>;
}

const PRESET_CHOICES: readonly Choice[] = PRESETS.map((p) => ({
  id: p.id,
  label: p.label,
  description: p.description,
  Icon: p.Icon,
}));

const LEVEL_CHOICES: readonly Choice[] = ANIMATION_LEVELS.map((l) => ({
  id: l.id,
  label: l.label,
  description: l.description,
}));

/**
 * One wizard step: a `role="radiogroup"` of {@link Choice} cards with roving-tabindex keyboard
 * support. Focuses its selected card on mount, so both the initial open and each step switch land
 * keyboard focus on the live selection rather than losing it to the document.
 */
function ChoiceStep({
  choices,
  selectedId,
  onSelect,
  ariaLabel,
  testid,
  itemTestidPrefix,
  initialFocusRef,
}: {
  readonly choices: readonly Choice[];
  readonly selectedId: string;
  readonly onSelect: (id: string) => void;
  readonly ariaLabel: string;
  readonly testid: string;
  readonly itemTestidPrefix: string;
  /** The dialog's Modal focus target — pointed at the selected card so the initial open lands here. */
  readonly initialFocusRef: RefObject<HTMLButtonElement | null>;
}) {
  const selectedIndex = Math.max(
    0,
    choices.findIndex((c) => c.id === selectedId),
  );

  const { refs, selectAt, onKeyDown } = useRovingRadioGroup<HTMLButtonElement>({
    count: choices.length,
    onSelect: (index) => onSelect(choices[index]!.id),
  });

  // Land focus on the live selection whenever this step mounts. The Modal focuses `initialFocusRef`
  // on *open* (the initial mount); this effect covers each later step switch, since the parent keys
  // this component by step so it remounts (the Modal does not re-focus while already open).
  useEffect(() => {
    refs.current[selectedIndex]?.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div role="radiogroup" aria-label={ariaLabel} data-testid={testid} className="flex flex-col gap-2">
      {choices.map((choice, index) => {
        const checked = index === selectedIndex;
        return (
          <button
            key={choice.id}
            ref={(el) => {
              refs.current[index] = el;
              if (checked) initialFocusRef.current = el;
            }}
            type="button"
            role="radio"
            aria-checked={checked}
            data-testid={`${itemTestidPrefix}-${choice.id}`}
            tabIndex={checked ? 0 : -1}
            onClick={() => selectAt(index)}
            onKeyDown={(event) => onKeyDown(event, index)}
            className={cn('flex items-start gap-3 [&_svg]:size-5', presetCardClassName(checked))}
          >
            {choice.Icon ? (
              <choice.Icon aria-hidden className="mt-0.5 shrink-0 text-muted-foreground" />
            ) : null}
            <span className="min-w-0 flex-1">
              <span className="flex items-center gap-2 text-sm font-medium text-foreground">
                {choice.label}
              </span>
              <span className="mt-0.5 block text-xs text-muted-foreground">{choice.description}</span>
            </span>
            {checked ? <CheckIcon aria-hidden className="mt-0.5 shrink-0 text-primary" /> : null}
          </button>
        );
      })}
    </div>
  );
}

/** Per-step dialog title + description (Modal chrome). */
const STEP_CHROME = [
  {
    title: 'Set up your modules',
    description:
      'Pick a starting point that fits how you work. You can fine-tune everything later, or leave it all switched on.',
  },
  {
    title: 'How lively should Gubbins feel?',
    description:
      'Choose how much the interface animates. You can change this any time in Settings → Appearance.',
  },
] as const;

/**
 * The wizard dialog itself. Self-contained: it records the outcome in the stores and then calls
 * {@link onClose} so the host can tear down whatever mounted it (the root gate relies on the
 * `firstRunComplete` flip; the manager's "Run setup again" flips local state).
 */
export function FirstRunModulesDialog({ onClose }: { readonly onClose: () => void }) {
  const applyPreset = useModulesStore((state) => state.applyPreset);
  const completeFirstRun = useModulesStore((state) => state.completeFirstRun);
  const animationLevel = usePreferencesStore((state) => state.animationLevel);
  const setAnimationLevel = usePreferencesStore((state) => state.setAnimationLevel);

  const [step, setStep] = useState<0 | 1>(0);
  // Default to "Everything" (PRESETS[0]) — the current everything-on behaviour, so confirming
  // without changing the selection keeps exactly what the user had.
  const [selectedPreset, setSelectedPreset] = useState<PresetId>(PRESETS[0]!.id);

  // The Modal focuses this on open; the current step points it at its selected card so keyboard
  // users land on the live selection rather than the dialog container.
  const initialFocusRef = useRef<HTMLButtonElement>(null);

  /** Apply the chosen modules preset, then complete and dismiss. */
  const useThisSetup = () => {
    applyPreset(selectedPreset);
    completeFirstRun();
    onClose();
  };

  /** Skip / dismiss: complete without changing module intent (everything stays on), then dismiss. */
  const skip = () => {
    completeFirstRun();
    onClose();
  };

  const chrome = STEP_CHROME[step];

  return (
    <Modal
      open
      onClose={skip}
      title={chrome.title}
      description={chrome.description}
      initialFocusRef={initialFocusRef}
      className="max-w-xl"
    >
      {step === 0 ? (
        <ChoiceStep
          key="modules"
          choices={PRESET_CHOICES}
          selectedId={selectedPreset}
          onSelect={(id) => setSelectedPreset(id as PresetId)}
          ariaLabel="Module presets"
          testid="first-run-presets"
          itemTestidPrefix="first-run-preset"
          initialFocusRef={initialFocusRef}
        />
      ) : (
        <ChoiceStep
          key="animation"
          choices={LEVEL_CHOICES}
          selectedId={animationLevel}
          onSelect={(id) => setAnimationLevel(id as AnimationLevel)}
          ariaLabel="Animation level"
          testid="first-run-animation"
          itemTestidPrefix="first-run-animation"
          initialFocusRef={initialFocusRef}
        />
      )}

      <div className="mt-6 flex justify-between gap-2">
        {step === 0 ? (
          <Button variant="ghost" data-testid="first-run-skip" onClick={skip}>
            Skip
          </Button>
        ) : (
          <Button variant="ghost" data-testid="first-run-back" onClick={() => setStep(0)}>
            Back
          </Button>
        )}
        {step === 0 ? (
          <Button data-testid="first-run-next" onClick={() => setStep(1)}>
            Next
          </Button>
        ) : (
          <Button data-testid="first-run-use" onClick={useThisSetup}>
            Use this setup
          </Button>
        )}
      </div>
    </Modal>
  );
}
