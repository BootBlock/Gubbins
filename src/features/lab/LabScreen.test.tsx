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
import { render, screen, cleanup, fireEvent } from '@testing-library/react';

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
import { useLabStore } from '@/state/stores/useLabStore';
import { usePreferencesStore } from '@/state/stores/usePreferencesStore';

const CLEAN = { occasionModes: {}, flags: {} } as const;

beforeEach(() => {
  useLabStore.setState(CLEAN);
  usePreferencesStore.setState({ backgroundEffect: 'snow' });
});
afterEach(() => {
  cleanup();
  useLabStore.setState(CLEAN);
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

  it('resets every override', () => {
    useLabStore.setState({ occasionModes: { cats: 'on' }, flags: { 'seasonal-dense': true } });
    render(<LabScreen />);
    fireEvent.click(screen.getByTestId('lab-reset'));
    expect(useLabStore.getState().occasionModes).toEqual({});
    expect(useLabStore.getState().flags).toEqual({});
  });
});
