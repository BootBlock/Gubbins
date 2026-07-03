/**
 * Component tests for the first-run module chooser (modular-ui-plan §4, Phase 8).
 *
 * Drives the real {@link useModulesStore} (reset between tests) rather than mocking it, so
 * the assertions exercise the true intent/first-run wiring. Covers the four behaviours the
 * chooser owns: it shows once while the flow is outstanding, picking a preset applies it and
 * completes, Skip completes without touching intent (everything stays on), and it never
 * re-shows once completed. The root gate's `/modules` suppression is checked via a
 * configurable router-state mock.
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
import { OPTIONAL_FEATURE_IDS } from './feature-registry';

beforeEach(() => {
  mockPathname = '/';
  useModulesStore.setState({ intent: {}, firstRunComplete: false });
});
afterEach(() => {
  cleanup();
  useModulesStore.setState({ intent: {}, firstRunComplete: false });
});

describe('FirstRunModules — visibility', () => {
  it('shows the chooser once while the first-run flow is outstanding', () => {
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

describe('FirstRunModules — picking a preset', () => {
  it('applies the selected preset and completes', () => {
    render(<FirstRunModules />);

    // Selecting Minimal marks its radio checked, then "Use this setup" applies it.
    fireEvent.click(screen.getByTestId('first-run-preset-minimal'));
    expect(screen.getByTestId('first-run-preset-minimal').getAttribute('aria-checked')).toBe('true');

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

    fireEvent.click(screen.getByTestId('first-run-use'));

    const state = useModulesStore.getState();
    expect(state.firstRunComplete).toBe(true);
    for (const id of OPTIONAL_FEATURE_IDS) {
      expect(state.intent[id]).toBe(true);
    }
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
  });

  it('dismissing via Escape also skips (completes, intent untouched)', () => {
    render(<FirstRunModules />);
    fireEvent.keyDown(document, { key: 'Escape' });

    const state = useModulesStore.getState();
    expect(state.firstRunComplete).toBe(true);
    expect(state.intent).toEqual({});
  });
});
