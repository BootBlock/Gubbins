/**
 * First-run module chooser (modular-ui-plan §4, Phase 8).
 *
 * A skippable one-time wizard offering the curated {@link PRESETS} as a single-select
 * radiogroup of cards. Shown once at the app root when the modules first-run flow has not
 * been completed (see {@link FirstRunModules}); it never re-shows once dismissed because
 * every exit — picking a setup, skipping, or dismissing via Escape/backdrop/Close — sets
 * `firstRunComplete`.
 *
 * Two terminal choices:
 * - **Use this setup** applies the selected preset (`applyPreset`) then completes.
 * - **Skip** (and any dismiss) completes *without* touching intent, so everything stays on
 *   — today's default behaviour, nothing hidden by surprise.
 *
 * The same dialog is re-opened from the Modules manager's "Run setup again" action via
 * {@link FirstRunModulesDialog} with local mount state, so re-running never relies on
 * un-persisting the completion flag.
 */
import { useRef, useState } from 'react';
import { useRouterState } from '@tanstack/react-router';
import { Button, Modal, useRovingRadioGroup } from '@/components/foundry';
import { CheckIcon } from '@/components/icons';
import { cn } from '@/lib/utils';
import { useModulesStore } from '@/state/stores/useModulesStore';
import { presetCardClassName } from './preset-card';
import { PRESETS, type PresetId } from './presets';

/**
 * Root-mounted gate for the first-run chooser. Renders the dialog once, on any route,
 * while the first-run flow is outstanding — except on the `/modules` manager itself, where
 * the same choice is already front-and-centre (and its "Run setup again" hosts the dialog),
 * so stacking the wizard on top would be redundant.
 */
export function FirstRunModules() {
  const firstRunComplete = useModulesStore((state) => state.firstRunComplete);
  const onModulesScreen = useRouterState({ select: (state) => state.location.pathname === '/modules' });

  if (firstRunComplete || onModulesScreen) return null;
  // Dismissing at the root simply completes the flow; the flag flip unmounts this.
  return <FirstRunModulesDialog onClose={() => {}} />;
}

/**
 * The chooser dialog itself. Self-contained: it records the outcome in the store and then
 * calls {@link onClose} so the host can tear down whatever mounted it (the root gate relies
 * on the `firstRunComplete` flip; the manager's "Run setup again" flips local state).
 */
export function FirstRunModulesDialog({ onClose }: { readonly onClose: () => void }) {
  const applyPreset = useModulesStore((state) => state.applyPreset);
  const completeFirstRun = useModulesStore((state) => state.completeFirstRun);

  // Default to "Everything" — the current everything-on behaviour, so a user who confirms
  // without changing the selection keeps exactly what they had.
  const [selected, setSelected] = useState<PresetId>(PRESETS[0]!.id);
  const selectedIndex = Math.max(
    0,
    PRESETS.findIndex((preset) => preset.id === selected),
  );

  // Focus the selected card on open so keyboard users land on the live selection rather
  // than the Close button (Modal `initialFocusRef` seam).
  const initialFocusRef = useRef<HTMLButtonElement>(null);

  const { refs, selectAt, onKeyDown } = useRovingRadioGroup<HTMLButtonElement>({
    count: PRESETS.length,
    onSelect: (index) => setSelected(PRESETS[index]!.id),
  });

  /** Apply the chosen preset, then complete and dismiss. */
  const useThisSetup = () => {
    applyPreset(selected);
    completeFirstRun();
    onClose();
  };

  /** Skip / dismiss: complete without changing intent (everything stays on), then dismiss. */
  const skip = () => {
    completeFirstRun();
    onClose();
  };

  return (
    <Modal
      open
      onClose={skip}
      title="Set up your modules"
      description="Pick a starting point that fits how you work. You can fine-tune everything later, or leave it all switched on."
      initialFocusRef={initialFocusRef}
      className="max-w-xl"
    >
      <div
        role="radiogroup"
        aria-label="Module presets"
        data-testid="first-run-presets"
        className="flex flex-col gap-2"
      >
        {PRESETS.map((preset, index) => {
          const checked = index === selectedIndex;
          return (
            <button
              key={preset.id}
              ref={(el) => {
                refs.current[index] = el;
                if (checked) initialFocusRef.current = el;
              }}
              type="button"
              role="radio"
              aria-checked={checked}
              data-testid={`first-run-preset-${preset.id}`}
              tabIndex={checked ? 0 : -1}
              onClick={() => selectAt(index)}
              onKeyDown={(event) => onKeyDown(event, index)}
              className={cn('flex items-start gap-3 [&_svg]:size-5', presetCardClassName(checked))}
            >
              <preset.Icon aria-hidden className="mt-0.5 shrink-0 text-muted-foreground" />
              <span className="min-w-0 flex-1">
                <span className="flex items-center gap-2 text-sm font-medium text-foreground">
                  {preset.label}
                </span>
                <span className="mt-0.5 block text-xs text-muted-foreground">{preset.description}</span>
              </span>
              {checked ? <CheckIcon aria-hidden className="mt-0.5 shrink-0 text-primary" /> : null}
            </button>
          );
        })}
      </div>

      <div className="mt-6 flex justify-end gap-2">
        <Button variant="ghost" data-testid="first-run-skip" onClick={skip}>
          Skip
        </Button>
        <Button data-testid="first-run-use" onClick={useThisSetup}>
          Use this setup
        </Button>
      </div>
    </Modal>
  );
}
