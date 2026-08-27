/**
 * Component tests for the hidden lab screen.
 *
 * The screen's job is narrow — render the two registries as controls and write the chosen
 * override into the store — so that is what is asserted, plus the two pieces of feedback that
 * make the switches usable: the "falling now" status tracking the same resolution the background
 * layer runs, and the reminder that a garnish needs an effect to ride. Dependencies are stubbed at
 * the module boundary (happy-dom, no router or QueryClient) and the Foundry Selects are
 * click-driven per the component-test conventions.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';

// The seed action is the one lab feature that writes to the database, so the repository is stubbed
// and asserted on directly — these tests are as much about *not* writing (before confirmation) as
// about writing.
const createMany = vi.fn(async (inputs: readonly unknown[]) => inputs.map(() => ({})));
vi.mock('@/db/repositories', () => ({
  getItemRepository: () => ({ createMany }),
}));

// Plain-anchor Link so PageHeader renders without a RouterProvider.
vi.mock('@tanstack/react-router', () => ({
  Link: ({ children, to, ...props }: { children: React.ReactNode; to: string; [k: string]: unknown }) => (
    <a href={to} {...props}>
      {children}
    </a>
  ),
}));

vi.mock('@/components/BrandMark', () => ({
  BrandMark: () => <span data-testid="brand-mark" />,
}));

vi.mock('@/components/nav/AppNav', () => ({
  AppNav: () => <button type="button" data-testid="app-nav" aria-label="Navigation menu" />,
}));

vi.mock('@/features/command-palette/HeaderSearch', () => ({
  HeaderSearch: () => <button type="button" data-testid="header-search" />,
}));

vi.mock('@/components/icons', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/components/icons')>();
  return Object.fromEntries(Object.keys(actual).map((k) => [k, () => <span data-testid={`icon-${k}`} />]));
});

import { LabScreen } from './LabScreen';
import { BurstProvider } from '@/components/foundry';
import { useLabStore } from '@/state/stores/useLabStore';
import { usePreferencesStore } from '@/state/stores/usePreferencesStore';
import { setClockOffsetMs } from '@/lib/clock';
import { startLabClock } from './lab-clock';
import { useSessionStore } from '@/state/stores/useSessionStore';
import { UNRESTRICTED_AUTHORITY } from '@/features/users/permissions';

const CLEAN = { dateOverride: null, occasionModes: {}, weatherMode: 'auto', flags: {} } as const;

beforeEach(() => {
  createMany.mockClear();
  useLabStore.setState(CLEAN);
  usePreferencesStore.setState({ backgroundEffect: 'snow' });
  // Every test but the permission suite below runs as single-user mode does — unrestricted.
  useSessionStore.setState({ authority: UNRESTRICTED_AUTHORITY });
});
afterEach(() => {
  cleanup();
  useLabStore.setState(CLEAN);
  useSessionStore.setState({ authority: UNRESTRICTED_AUTHORITY });
});

/** Open a combobox by accessible name and click one of its options. */
function choose(name: string, option: string) {
  fireEvent.click(screen.getByRole('combobox', { name }));
  fireEvent.click(screen.getByRole('option', { name: option }));
}

describe('LabScreen', () => {
  it('lists every occasion, defaulting to Auto', () => {
    render(<LabScreen />);
    expect(screen.getByTestId('lab-occasion-christmas')).toHaveTextContent('Auto');
    expect(screen.getByText('Halloween')).toBeInTheDocument();
    expect(screen.getByText('the week either side of Easter Sunday')).toBeInTheDocument();
  });

  it('stores a forced occasion, and reports it as falling now', () => {
    render(<LabScreen />);
    choose('Halloween garnish', 'Force on');
    expect(useLabStore.getState().occasionModes.halloween).toBe('on');
    expect(screen.getByTestId('lab-seasonal-status')).toHaveTextContent('Falling now: Halloween.');
  });

  it('stores a suppressed occasion', () => {
    render(<LabScreen />);
    choose('Christmas garnish', 'Force off');
    expect(useLabStore.getState().occasionModes.christmas).toBe('off');
  });

  it('warns that a forced garnish needs an effect to ride, and stops once one is chosen', () => {
    usePreferencesStore.setState({ backgroundEffect: 'none' });
    render(<LabScreen />);
    choose('Halloween garnish', 'Force on');
    expect(screen.getByTestId('lab-seasonal-status')).toHaveTextContent('pick Rain or Snow');

    // …either by choosing an effect, or by the flag that runs the garnish on its own.
    choose('Seasonal garnish without a background effect', 'On');
    expect(screen.getByTestId('lab-seasonal-status')).not.toHaveTextContent('pick Rain or Snow');
  });

  it('stores a boolean flag', () => {
    render(<LabScreen />);
    choose('Dense seasonal garnish', 'On');
    expect(useLabStore.getState().flags['seasonal-dense']).toBe(true);
  });

  it('stores a forced snow-weather mode', () => {
    render(<LabScreen />);
    expect(screen.getByTestId('lab-weather-mode')).toHaveTextContent('Auto');
    choose('Weather', 'Blizzard');
    expect(useLabStore.getState().weatherMode).toBe('blizzard');
  });

  it('warns when a forced weather mode has no snow to drive, but not under Auto', () => {
    usePreferencesStore.setState({ backgroundEffect: 'none' });
    render(<LabScreen />);
    expect(screen.queryByTestId('lab-weather-status')).toBeNull();
    choose('Weather', 'Squall');
    expect(screen.getByTestId('lab-weather-status')).toHaveTextContent('not set to Snow');
  });

  it('resets every override', () => {
    useLabStore.setState({
      dateOverride: '2030-01-01',
      occasionModes: { cats: 'on' },
      weatherMode: 'thundersnow',
      flags: { 'seasonal-dense': true },
    });
    render(<LabScreen />);
    fireEvent.click(screen.getByTestId('lab-reset'));
    expect(useLabStore.getState().dateOverride).toBeNull();
    expect(useLabStore.getState().occasionModes).toEqual({});
    expect(useLabStore.getState().weatherMode).toBe('auto');
    expect(useLabStore.getState().flags).toEqual({});
  });

  describe('date override', () => {
    it('stores a chosen date and reports it', () => {
      render(<LabScreen />);
      fireEvent.change(screen.getByTestId('lab-date-input'), { target: { value: '2026-12-24' } });
      expect(useLabStore.getState().dateOverride).toBe('2026-12-24');
      expect(screen.getByTestId('lab-date-status')).toHaveTextContent('2026-12-24');
    });

    it('reads a cleared field as no override rather than an unparseable date', () => {
      useLabStore.setState({ dateOverride: '2026-12-24' });
      render(<LabScreen />);
      fireEvent.change(screen.getByTestId('lab-date-input'), { target: { value: '' } });
      expect(useLabStore.getState().dateOverride).toBeNull();
    });

    it('offers an explicit way back to the real date, disabled when already real', () => {
      useLabStore.setState({ dateOverride: '2026-12-24' });
      render(<LabScreen />);
      const clear = screen.getByTestId('lab-date-clear');
      expect(clear).toBeEnabled();
      fireEvent.click(clear);
      expect(useLabStore.getState().dateOverride).toBeNull();
      expect(screen.getByTestId('lab-date-clear')).toBeDisabled();
    });

    it('resolves the seasonal occasion against the overridden date', () => {
      // The screen reads the shifted clock, which only moves once the lab clock is running — the
      // same wiring `main.tsx` performs before first render, so the test starts it too.
      useLabStore.setState({ dateOverride: '2026-10-31' });
      const stop = startLabClock();
      try {
        render(<LabScreen />);
        expect(screen.getByTestId('lab-seasonal-status')).toHaveTextContent('Falling now: Halloween.');
      } finally {
        stop();
        setClockOffsetMs(0);
      }
    });
  });

  describe('firework trigger', () => {
    // The burst only plays at the maximal animation level, so each test states the level it means.
    afterEach(() => usePreferencesStore.setState({ animationLevel: 'balanced' }));

    it('plays the firework on demand when the animation level allows it', () => {
      usePreferencesStore.setState({ animationLevel: 'headache' });
      render(
        <BurstProvider
          motionProvider={() => ({ matches: false, addEventListener() {}, removeEventListener() {} })}
        >
          <LabScreen />
        </BurstProvider>,
      );
      expect(screen.queryByTestId('burst-overlay')).not.toBeInTheDocument();

      fireEvent.click(screen.getByTestId('lab-burst-fire'));

      expect(screen.getByTestId('burst-overlay')).toBeInTheDocument();
      expect(screen.getAllByTestId('burst-particle').length).toBeGreaterThan(0);
      expect(screen.getByTestId('lab-burst-status')).toHaveTextContent('Fired');
    });

    it('says up front that nothing will play at a calmer animation level', () => {
      usePreferencesStore.setState({ animationLevel: 'balanced' });
      render(
        <BurstProvider
          motionProvider={() => ({ matches: false, addEventListener() {}, removeEventListener() {} })}
        >
          <LabScreen />
        </BurstProvider>,
      );
      expect(screen.getByTestId('lab-burst-status')).toHaveTextContent('Total Gubbage');

      // …and the button genuinely stays a no-op rather than the hint being cosmetic.
      fireEvent.click(screen.getByTestId('lab-burst-fire'));
      expect(screen.queryByTestId('burst-overlay')).not.toBeInTheDocument();
    });
  });

  describe('seed action', () => {
    it('does not write anything until the confirmation is accepted', () => {
      render(<LabScreen />);
      fireEvent.click(screen.getByTestId('lab-seed-start'));
      expect(screen.getByRole('dialog', { name: /Add 100 synthetic items/ })).toBeInTheDocument();
      expect(createMany).not.toHaveBeenCalled();
    });

    it('writes nothing when the confirmation is dismissed', () => {
      render(<LabScreen />);
      fireEvent.click(screen.getByTestId('lab-seed-start'));
      fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
      expect(createMany).not.toHaveBeenCalled();
    });

    it('seeds the chosen number of items once confirmed, and reports it', async () => {
      render(<LabScreen />);
      fireEvent.click(screen.getByTestId('lab-seed-start'));
      fireEvent.click(screen.getByTestId('lab-seed-confirm-action'));
      await waitFor(() => expect(createMany).toHaveBeenCalledTimes(1));
      expect(createMany.mock.calls[0]?.[0]).toHaveLength(100);
      await waitFor(() =>
        expect(screen.getByTestId('lab-seed-status')).toHaveTextContent('Added 100 synthetic items.'),
      );
    });

    it('reports a failure rather than claiming items were added', async () => {
      createMany.mockRejectedValueOnce(new Error('database closed'));
      render(<LabScreen />);
      fireEvent.click(screen.getByTestId('lab-seed-start'));
      fireEvent.click(screen.getByTestId('lab-seed-confirm-action'));
      await waitFor(() =>
        expect(screen.getByTestId('lab-seed-status')).toHaveTextContent('Could not add the items.'),
      );
    });
  });
});

describe('LabScreen — without storage:write', () => {
  /** A signed-in session that holds no storage permission at all. */
  function signInWithoutStorageWrite() {
    useSessionStore.setState({ authority: { mode: 'granted', grants: new Set(['storage:read']) } });
  }

  it('hides the controls that write to the database or shift the clock', () => {
    useLabStore.setState({ dateOverride: '2026-12-24' });
    signInWithoutStorageWrite();
    render(<LabScreen />);
    expect(screen.queryByTestId('lab-reset')).toBeNull();
    expect(screen.queryByTestId('lab-date-input')).toBeNull();
    expect(screen.queryByTestId('lab-date-clear')).toBeNull();
    expect(screen.queryByTestId('lab-seed-start')).toBeNull();
    expect(screen.queryByTestId('lab-seed-count')).toBeNull();
  });

  it('leaves the device-local display switches alone', () => {
    signInWithoutStorageWrite();
    render(<LabScreen />);
    expect(screen.getByTestId('lab-occasion-christmas')).toBeInTheDocument();
    expect(screen.getByTestId('lab-weather-mode')).toBeInTheDocument();
    expect(screen.getByTestId('lab-flag-seasonal-dense')).toBeInTheDocument();
    expect(screen.getByTestId('lab-burst-fire')).toBeInTheDocument();

    choose('Dense seasonal garnish', 'On');
    expect(useLabStore.getState().flags['seasonal-dense']).toBe(true);
  });

  it('keeps them for a session that does hold storage:write', () => {
    useSessionStore.setState({
      authority: { mode: 'granted', grants: new Set(['storage:read', 'storage:write']) },
    });
    render(<LabScreen />);
    expect(screen.getByTestId('lab-reset')).toBeInTheDocument();
    expect(screen.getByTestId('lab-date-input')).toBeInTheDocument();
    expect(screen.getByTestId('lab-seed-start')).toBeInTheDocument();
  });
});
