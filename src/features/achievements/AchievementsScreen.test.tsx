/**
 * Component tests for {@link AchievementsScreen} (issue #412).
 *
 * The screen's job is narrow — render every registered achievement, and say for each whether it
 * has been earned and when — so that is what is asserted. In particular it must distinguish the
 * three states the store records: not earned, earned with a known instant, and earned with the
 * instant unknown. The chrome around it (router Link, AppNav, header search) is stubbed at the
 * module boundary per the component-test conventions.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, within } from '@testing-library/react';

// Plain-anchor Link so PageHeader renders without a RouterProvider.
vi.mock('@tanstack/react-router', () => ({
  Link: ({ children, to, ...props }: { children: React.ReactNode; to: string; [k: string]: unknown }) => (
    <a href={to} {...props}>
      {children}
    </a>
  ),
}));

vi.mock('@/components/BrandMark', () => ({ BrandMark: () => <span data-testid="brand-mark" /> }));
vi.mock('@/components/nav/AppNav', () => ({
  AppNav: () => <button type="button" data-testid="app-nav" aria-label="Navigation menu" />,
}));
vi.mock('@/features/command-palette/HeaderSearch', () => ({
  HeaderSearch: () => <button type="button" data-testid="header-search" />,
}));

import { AchievementsScreen } from './AchievementsScreen';
import { ACHIEVEMENTS } from './registry';
import { useAchievementsStore } from '@/state/stores/useAchievementsStore';

beforeEach(() => {
  useAchievementsStore.setState({ unlocked: {} });
});
afterEach(cleanup);

describe('AchievementsScreen', () => {
  it('lists every registered achievement, earned or not', () => {
    render(<AchievementsScreen />);
    const cards = screen.getAllByRole('listitem');
    expect(cards).toHaveLength(ACHIEVEMENTS.length);
    expect(screen.getByRole('heading', { name: 'First item' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'A thousand items' })).toBeInTheDocument();
  });

  it('marks an unearned achievement locked, and shows what earns it', () => {
    render(<AchievementsScreen />);
    const card = screen.getByRole('heading', { name: 'First item' }).closest('li');
    expect(card).not.toBeNull();
    expect(within(card!).getByText('Locked')).toBeInTheDocument();
    expect(within(card!).getByText('Add your first item.')).toBeInTheDocument();
  });

  it('shows the date an achievement was earned', () => {
    // 2023-11-14, an instant the app watched happen.
    useAchievementsStore.setState({ unlocked: { 'first-item': Date.parse('2023-11-14T12:00:00Z') } });
    render(<AchievementsScreen />);

    const card = screen.getByRole('heading', { name: 'First item' }).closest('li');
    expect(within(card!).queryByText('Locked')).not.toBeInTheDocument();
    expect(within(card!).getByText(/^Unlocked .+/)).toBeInTheDocument();
  });

  it('says only "Unlocked" for an achievement whose instant is not known', () => {
    // Backfilled from an inventory that was already past the threshold — earned, date unknown.
    useAchievementsStore.setState({ unlocked: { 'first-item': null } });
    render(<AchievementsScreen />);

    const card = screen.getByRole('heading', { name: 'First item' }).closest('li');
    expect(within(card!).getByText('Unlocked')).toBeInTheDocument();
  });

  it('counts how many have been earned', () => {
    useAchievementsStore.setState({ unlocked: { 'first-item': null, 'stock-take': 1 } });
    render(<AchievementsScreen />);
    expect(screen.getByTestId('achievements-progress')).toHaveTextContent(
      `2 of ${ACHIEVEMENTS.length} unlocked`,
    );
  });
});
