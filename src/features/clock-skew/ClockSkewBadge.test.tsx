import { afterEach, describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { useClockSkewStore } from '@/state/stores/useClockSkewStore';
import { useLabStore } from '@/state/stores/useLabStore';
import { ClockSkewBadge } from './ClockSkewBadge';

afterEach(() => {
  useClockSkewStore.setState({ skewMs: 0, measuredAt: 0 });
  useLabStore.setState({ dateOverride: null });
});

describe('ClockSkewBadge', () => {
  it('stays out of the way while the device clock is trustworthy', () => {
    render(<ClockSkewBadge />);
    expect(screen.queryByTestId('clock-skew-badge')).toBeNull();
  });

  it('stays quiet for a skew below the notice threshold', () => {
    // Seconds of drift are normal and self-correcting — not worth a permanent on-screen warning.
    useClockSkewStore.setState({ skewMs: -30_000, measuredAt: 1 });
    render(<ClockSkewBadge />);
    expect(screen.queryByTestId('clock-skew-badge')).toBeNull();
  });

  it('says the clock runs ahead when the correction is negative', () => {
    useClockSkewStore.setState({ skewMs: -3 * 3_600_000, measuredAt: 1 });
    render(<ClockSkewBadge />);
    expect(screen.getByTestId('clock-skew-badge')).toHaveTextContent('Device clock is 3 hours ahead');
  });

  it('says the clock runs behind when the correction is positive', () => {
    useClockSkewStore.setState({ skewMs: 2 * 86_400_000, measuredAt: 1 });
    render(<ClockSkewBadge />);
    expect(screen.getByTestId('clock-skew-badge')).toHaveTextContent('Device clock is 2 days behind');
  });

  it('uses the singular duration form for a one-unit skew', () => {
    useClockSkewStore.setState({ skewMs: -3_600_000, measuredAt: 1 });
    render(<ClockSkewBadge />);
    expect(screen.getByTestId('clock-skew-badge')).toHaveTextContent('1 hour ahead');
  });

  it('announces itself politely rather than interrupting', () => {
    useClockSkewStore.setState({ skewMs: -3 * 3_600_000, measuredAt: 1 });
    render(<ClockSkewBadge />);
    const badge = screen.getByTestId('clock-skew-badge');
    expect(badge).toHaveAttribute('role', 'status');
    expect(badge).toHaveAttribute('aria-live', 'polite');
  });

  it('lifts clear of the lab date-override badge when both are showing', () => {
    useClockSkewStore.setState({ skewMs: -3 * 3_600_000, measuredAt: 1 });
    useLabStore.setState({ dateOverride: '2026-12-24' });
    render(<ClockSkewBadge />);
    expect(screen.getByTestId('clock-skew-badge').className).toContain('bottom-11');
  });
});
