import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { ClockOverrideBadge } from './ClockOverrideBadge';
import { useLabStore } from '@/state/stores/useLabStore';

const CLEAN = { dateOverride: null, occasionModes: {}, flags: {} } as const;

beforeEach(() => useLabStore.setState(CLEAN));
afterEach(() => {
  cleanup();
  useLabStore.setState(CLEAN);
});

describe('ClockOverrideBadge', () => {
  it('renders nothing in normal use', () => {
    const { container } = render(<ClockOverrideBadge />);
    expect(container).toBeEmptyDOMElement();
  });

  it('says so, and names the date, while the clock is shifted', () => {
    useLabStore.setState({ dateOverride: '2026-12-24' });
    render(<ClockOverrideBadge />);
    const badge = screen.getByTestId('clock-override-badge');
    expect(badge).toHaveTextContent('2026-12-24');
    // Announced politely rather than as an alert: it is a standing condition, not an event.
    expect(badge).toHaveAttribute('role', 'status');
    expect(badge).toHaveAttribute('aria-live', 'polite');
  });

  it('disappears again once the override is cleared', () => {
    useLabStore.setState({ dateOverride: '2026-12-24' });
    const { rerender } = render(<ClockOverrideBadge />);
    expect(screen.getByTestId('clock-override-badge')).toBeInTheDocument();
    useLabStore.getState().setDateOverride(null);
    rerender(<ClockOverrideBadge />);
    expect(screen.queryByTestId('clock-override-badge')).not.toBeInTheDocument();
  });
});
