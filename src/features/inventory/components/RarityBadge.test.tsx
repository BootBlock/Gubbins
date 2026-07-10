import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { RarityBadge } from './RarityBadge';

/**
 * The rarity gem pill shown in the item detail dialog. It tints itself from its own `data-rarity`
 * and carries an explanatory tooltip (the rarity is purely cosmetic).
 */
afterEach(cleanup);

describe('RarityBadge', () => {
  it('renders the tier label and carries its own data-rarity for the CSS tint', () => {
    render(<RarityBadge rarity="legendary" />);
    const badge = screen.getByTestId('rarity-badge');
    expect(badge).toHaveTextContent('Legendary');
    expect(badge.dataset.rarity).toBe('legendary');
  });

  it('explains what the rarity means in a tooltip on focus', () => {
    render(<RarityBadge rarity="rare" />);
    // The Tooltip wraps the badge; focusing its trigger opens the bubble immediately.
    fireEvent.focus(screen.getByTestId('rarity-badge').parentElement!);
    const tip = screen.getByRole('tooltip');
    expect(tip).toHaveTextContent(/collector card/i);
    expect(tip).toHaveTextContent(/purely cosmetic/i);
  });
});
