/**
 * Component tests for the first-run setup wizard (modular-ui-plan §4, Phase 8; animation step).
 *
 * Drives the real {@link useModulesStore} + {@link usePreferencesStore} (reset between tests)
 * rather than mocking them, so the assertions exercise the true intent/first-run/preference wiring.
 * Covers: it shows once while the flow is outstanding; step 1 picks a modules preset; Next advances
 * to step 2 where an animation level is picked and applied live; "Use this setup" applies the preset
 * and completes; Skip / Escape complete without touching module intent; and it never re-shows once
 * completed. The root gate's `/modules` suppression is checked via a configurable router-state mock.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';

// The root gate reads the live pathname; expose a mutable value the tests can steer.
let mockPathname = '/';
vi.mock('@tanstack/react-router', () => ({
  useRouterState: ({ select }: { select: (s: { location: { pathname: string } }) => unknown }) =>
    select({ location: { pathname: mockPathname } }),
}));

// Render every icon as a text-free span so card labels stay clean for text queries.
vi.mock('@/components/icons', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/components/icons')>();
  return Object.fromEntries(Object.keys(actual).map((k) => [k, () => <span data-testid={`icon-${k}`} />]));
});

import { FirstRunModules } from './FirstRunModules';
import { useModulesStore } from '@/state/stores/useModulesStore';
import { usePreferencesStore } from '@/state/stores/usePreferencesStore';
import { OPTIONAL_FEATURE_IDS } from './feature-registry';

/** Advance from the modules step to the animation step. */
function goToAnimationStep() {
  fireEvent.click(screen.getByTestId('first-run-next'));
}

beforeEach(() => {
  mockPathname = '/';
  useModulesStore.setState({ intent: {}, firstRunComplete: false });
  usePreferencesStore.setState({ animationLevel: 'balanced' });
});
afterEach(() => {
  cleanup();
  useModulesStore.setState({ intent: {}, firstRunComplete: false });
  usePreferencesStore.setState({ animationLevel: 'balanced' });
});

describe('FirstRunModules — visibility', () => {
  it('shows the wizard on the modules step while the first-run flow is outstanding', () => {
    render(<FirstRunModules />);
    expect(screen.getByRole('dialog', { name: 'Set up your modules' })).toBeTruthy();
    expect(screen.getByTestId('first-run-presets')).toBeTruthy();
    // Every preset is offered as a radio.
    for (const id of ['everything', 'minimal', 'home-hobby', 'maker-workshop', 'asset-equipment']) {
      expect(screen.getByTestId(`first-run-preset-${id}`)).toBeTruthy();
    }
  });

  it('never shows once the first-run flow is complete', () => {
    useModulesStore.setState({ firstRunComplete: true });
    render(<FirstRunModules />);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('is suppressed on the /modules manager to avoid a double surface', () => {
    mockPathname = '/modules';
    render(<FirstRunModules />);
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});

describe('FirstRunModules — modules step', () => {
  it('applies the selected preset and completes (after the animation step)', () => {
    render(<FirstRunModules />);

    // Selecting Minimal marks its radio checked.
    fireEvent.click(screen.getByTestId('first-run-preset-minimal'));
    expect(screen.getByTestId('first-run-preset-minimal').getAttribute('aria-checked')).toBe('true');

    // Advance and finish.
    goToAnimationStep();
    fireEvent.click(screen.getByTestId('first-run-use'));

    const state = useModulesStore.getState();
    expect(state.firstRunComplete).toBe(true);
    // Minimal turns every optional feature off (core stays on via resolution).
    for (const id of OPTIONAL_FEATURE_IDS) {
      expect(state.intent[id]).toBe(false);
    }
  });

  it('applies the default Everything selection when confirmed unchanged', () => {
    render(<FirstRunModules />);
    // Everything is selected by default.
    expect(screen.getByTestId('first-run-preset-everything').getAttribute('aria-checked')).toBe('true');

    goToAnimationStep();
    fireEvent.click(screen.getByTestId('first-run-use'));

    const state = useModulesStore.getState();
    expect(state.firstRunComplete).toBe(true);
    for (const id of OPTIONAL_FEATURE_IDS) {
      expect(state.intent[id]).toBe(true);
    }
  });
});

describe('FirstRunModules — animation step', () => {
  it('advances to the animation step, applies a level live, and Back returns to modules', () => {
    render(<FirstRunModules />);
    goToAnimationStep();

    // Step 2 shows the animation radiogroup with a card per level.
    expect(screen.getByRole('dialog', { name: 'How lively should Gubbins feel?' })).toBeTruthy();
    expect(screen.getByTestId('first-run-animation')).toBeTruthy();
    for (const id of ['headache', 'balanced', 'calm', 'minimal', 'off']) {
      expect(screen.getByTestId(`first-run-animation-${id}`)).toBeTruthy();
    }

    // Picking a level applies it live to the preference store (previewed behind the dialog).
    fireEvent.click(screen.getByTestId('first-run-animation-calm'));
    expect(usePreferencesStore.getState().animationLevel).toBe('calm');

    // Back returns to the modules step (its preset radiogroup is shown again).
    fireEvent.click(screen.getByTestId('first-run-back'));
    expect(screen.getByTestId('first-run-presets')).toBeTruthy();
  });

  it('keeps the chosen level after finishing', () => {
    render(<FirstRunModules />);
    goToAnimationStep();
    // Pick a non-default level (the beforeEach resets to the `headache` default) so this proves a change.
    fireEvent.click(screen.getByTestId('first-run-animation-off'));
    fireEvent.click(screen.getByTestId('first-run-use'));

    expect(usePreferencesStore.getState().animationLevel).toBe('off');
    expect(useModulesStore.getState().firstRunComplete).toBe(true);
  });
});

describe('FirstRunModules — skipping', () => {
  it('completes without changing intent, leaving everything on', () => {
    render(<FirstRunModules />);
    fireEvent.click(screen.getByTestId('first-run-skip'));

    const state = useModulesStore.getState();
    expect(state.firstRunComplete).toBe(true);
    // Intent untouched — nothing hidden, today's default behaviour preserved.
    expect(state.intent).toEqual({});
    // The animation level was never touched, so it stays at the `balanced` fresh-install default.
    expect(usePreferencesStore.getState().animationLevel).toBe('balanced');
  });

  it('dismissing via Escape also skips (completes, intent untouched)', () => {
    render(<FirstRunModules />);
    fireEvent.keyDown(document, { key: 'Escape' });

    const state = useModulesStore.getState();
    expect(state.firstRunComplete).toBe(true);
    expect(state.intent).toEqual({});
  });
});
