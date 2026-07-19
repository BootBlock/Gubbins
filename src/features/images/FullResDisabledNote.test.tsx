/**
 * The note is the *visible* half of the critical-tier promise — the enforcement in
 * `full-res-policy` is silent on its own, because a thumbnail-only photo looks identical in
 * the grid. These pin that it appears at `critical` and nowhere else: at `locked` the Hard
 * Stop refuses the insert entirely, so promising a thumbnail would be its own false claim.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { useStorageStore } from '@/state/stores/useStorageStore';
import type { StorageTier } from '@/features/storage/tiers';
import { FullResDisabledNote } from './FullResDisabledNote';

afterEach(() => {
  cleanup();
  useStorageStore.setState({ tier: 'ok' });
});

function renderAt(tier: StorageTier) {
  useStorageStore.setState({ tier });
  render(<FullResDisabledNote />);
}

describe('FullResDisabledNote', () => {
  it('warns that photos are thumbnail-only at critical', () => {
    renderAt('critical');
    expect(screen.getByTestId('full-res-disabled-note')).toHaveTextContent(/thumbnails only/i);
  });

  it.each(['ok', 'warning'] as const)('renders nothing at %s, where full-res still saves', (tier) => {
    renderAt(tier);
    expect(screen.queryByTestId('full-res-disabled-note')).toBeNull();
  });

  it('renders nothing at locked, where no photo is saved at all', () => {
    renderAt('locked');
    expect(screen.queryByTestId('full-res-disabled-note')).toBeNull();
  });
});
