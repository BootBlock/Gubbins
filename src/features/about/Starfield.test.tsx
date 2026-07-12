/**
 * Component tests for the decorative About-screen starfield.
 *
 * The visual layer is CSS/compositor-only; these cover the behavioural wiring added in issue #61:
 * a random mood is projected onto `<html>` as `data-starfield` while the field is on screen (and
 * removed on unmount), and the app-wide weather layer is asked to yield via the backdrop flag.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import { Starfield } from './Starfield';
import { STARFIELD_VARIANTS } from '@/features/settings/theme-registry';
import { useBackdropStore } from '@/state/stores/useBackdropStore';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  delete document.documentElement.dataset.starfield;
  useBackdropStore.setState({ backdropActive: false });
});

describe('Starfield', () => {
  it('projects a randomly-chosen non-base mood onto <html> and clears it on unmount', () => {
    // Force the pick to a known non-`cosmic` variant (index 2 = 'aurora').
    vi.spyOn(Math, 'random').mockReturnValue(2 / STARFIELD_VARIANTS.length);
    const { unmount } = render(<Starfield />);

    expect(document.documentElement.dataset.starfield).toBe('aurora');
    expect(STARFIELD_VARIANTS).toContain(document.documentElement.dataset.starfield);

    unmount();
    expect(document.documentElement.dataset.starfield).toBeUndefined();
  });

  it('carries no attribute for the base cosmic look (index 0)', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0);
    render(<Starfield />);
    expect(document.documentElement.dataset.starfield).toBeUndefined();
  });

  it('raises the backdrop flag while mounted and lowers it on unmount', () => {
    const { unmount } = render(<Starfield />);
    expect(useBackdropStore.getState().backdropActive).toBe(true);
    unmount();
    expect(useBackdropStore.getState().backdropActive).toBe(false);
  });
});
