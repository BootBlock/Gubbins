/**
 * Component tests for the app-wide background weather layer.
 *
 * The particle engine itself needs a real 2D canvas context (absent under happy-dom, where
 * `getContext` returns null and {@link startPrecip} degrades to a no-op), so these cover the React
 * wiring: nothing renders when the effect is off, and an active effect mounts a decorative,
 * pointer-inert canvas without throwing.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { BackgroundEffects } from './BackgroundEffects';
import { usePreferencesStore } from '@/state/stores/usePreferencesStore';
import { useBackdropStore } from '@/state/stores/useBackdropStore';

afterEach(() => {
  cleanup();
  usePreferencesStore.setState({ backgroundEffect: 'none' });
  useBackdropStore.setState({ backdropActive: false });
});

describe('BackgroundEffects', () => {
  it('renders nothing when the effect is off (the default baseline)', () => {
    usePreferencesStore.setState({ backgroundEffect: 'none' });
    const { container } = render(<BackgroundEffects />);
    expect(container.firstChild).toBeNull();
    expect(screen.queryByTestId('background-effects')).toBeNull();
  });

  it('mounts a decorative, pointer-inert canvas for an active effect', () => {
    usePreferencesStore.setState({ backgroundEffect: 'rain' });
    render(<BackgroundEffects />);
    const canvas = screen.getByTestId('background-effects');
    expect(canvas.tagName).toBe('CANVAS');
    expect(canvas).toHaveAttribute('aria-hidden', 'true');
    expect(canvas.className).toContain('pointer-events-none');
  });

  it('yields (renders nothing) while a screen shows its own full-viewport backdrop', () => {
    // The About starfield raises this flag; the weather layer must not fight it for the backdrop.
    usePreferencesStore.setState({ backgroundEffect: 'rain' });
    useBackdropStore.setState({ backdropActive: true });
    const { container } = render(<BackgroundEffects />);
    expect(container.firstChild).toBeNull();
    expect(screen.queryByTestId('background-effects')).toBeNull();
  });
});
