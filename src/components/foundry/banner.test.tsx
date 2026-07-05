/**
 * Banner — the shared notice-strip control. Focused on {@link BannerProps.onDismiss}: the
 * single close-button implementation every dismissible banner in the app shares, so its
 * position and its tone-matched hover tint are guaranteed consistent everywhere.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { Banner } from './banner';

afterEach(cleanup);

describe('Banner', () => {
  it('renders no close button when onDismiss is omitted', () => {
    render(<Banner tone="info">Just a notice.</Banner>);
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('renders a close button that calls onDismiss when clicked', () => {
    const onDismiss = vi.fn();
    render(
      <Banner tone="warning" onDismiss={onDismiss} dismissTestId="the-dismiss">
        Careful now.
      </Banner>,
    );
    fireEvent.click(screen.getByTestId('the-dismiss'));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it('defaults the close button\'s accessible name to "Dismiss"', () => {
    render(
      <Banner tone="info" onDismiss={() => {}}>
        Notice.
      </Banner>,
    );
    expect(screen.getByRole('button', { name: 'Dismiss' })).toBeTruthy();
  });

  it('honours a custom dismissLabel', () => {
    render(
      <Banner tone="info" onDismiss={() => {}} dismissLabel="Dismiss the special notice">
        Notice.
      </Banner>,
    );
    expect(screen.getByRole('button', { name: 'Dismiss the special notice' })).toBeTruthy();
  });

  // Every tone's close button hovers with its OWN tone tint (never a fixed neutral grey), so
  // a warning banner's dismiss button never reads as if it belongs to an unrelated surface.
  it.each([
    ['info', 'hover:bg-primary/25'],
    ['success', 'hover:bg-success/25'],
    ['warning', 'hover:bg-warning/25'],
    ['danger', 'hover:bg-destructive/25'],
  ] as const)('tints the %s banner close button with %s on hover', (tone, hoverClass) => {
    render(
      <Banner tone={tone} onDismiss={() => {}} dismissTestId="tone-dismiss">
        Notice.
      </Banner>,
    );
    expect(screen.getByTestId('tone-dismiss').className).toContain(hoverClass);
  });

  it('defaults to the info tone hover when tone is omitted (matching bannerVariants default)', () => {
    render(
      <Banner onDismiss={() => {}} dismissTestId="untoned-dismiss">
        Notice.
      </Banner>,
    );
    expect(screen.getByTestId('untoned-dismiss').className).toContain('hover:bg-primary/25');
  });

  it('does not wrap the close button in a tooltip when dismissTooltip is omitted', () => {
    render(
      <Banner onDismiss={() => {}} dismissTestId="plain-dismiss">
        Notice.
      </Banner>,
    );
    fireEvent.focus(screen.getByTestId('plain-dismiss'));
    expect(screen.queryByRole('tooltip')).toBeNull();
  });

  it('shows dismissTooltip as rendered Markdown on the close button', () => {
    render(
      <Banner
        onDismiss={() => {}}
        dismissTestId="tooltipped-dismiss"
        dismissTooltip="Hidden until storage **fills further**."
      >
        Notice.
      </Banner>,
    );
    // Keyboard focus opens the Tooltip immediately (no hover delay) — see tooltip.test.tsx.
    fireEvent.focus(screen.getByTestId('tooltipped-dismiss'));
    const tooltip = screen.getByRole('tooltip');
    expect(tooltip.querySelector('strong')?.textContent).toBe('fills further');
  });
});
