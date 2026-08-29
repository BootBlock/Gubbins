import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Bar, barPercent } from './bar';

describe('barPercent', () => {
  it('rounds a fraction to a whole percentage', () => {
    expect(barPercent(0.14)).toBe(14);
    expect(barPercent(0.146)).toBe(15);
  });

  it('floors a positive fraction so a rounding-error row still shows a stub', () => {
    expect(barPercent(0.0001)).toBe(2);
  });

  // The floor must not apply to nothing: "no value here" and "a sliver of value here" have to
  // look different, or an empty breakdown reads as a full one of tiny bars.
  it('renders exactly zero as empty rather than as the floor', () => {
    expect(barPercent(0)).toBe(0);
    expect(barPercent(-1)).toBe(0);
    expect(barPercent(Number.NaN)).toBe(0);
    expect(barPercent(Number.POSITIVE_INFINITY)).toBe(0);
  });

  it('clamps a fraction above one', () => {
    expect(barPercent(1.4)).toBe(100);
  });
});

describe('Bar', () => {
  it('sets the fill width from the fraction and arms the grow-in', () => {
    const { container } = render(<Bar value={0.4} data-testid="bar" />);
    const fill = container.querySelector<HTMLElement>('.bg-primary');
    expect(fill?.style.width).toBe('40%');
    // The entrance is the point of the primitive — without this class the bar simply appears
    // at its final width (issue #448).
    expect(fill?.className).toContain('animate-bar-grow');
  });

  it('is decorative, because the figure is already in text beside it', () => {
    render(<Bar value={0.4} data-testid="bar" />);
    expect(screen.getByTestId('bar')).toHaveAttribute('aria-hidden', 'true');
    expect(screen.queryByRole('progressbar')).not.toBeInTheDocument();
  });

  it('tints the fill with the given token class', () => {
    const { container } = render(<Bar value={0.5} fillClassName="bg-warning" />);
    expect(container.querySelector('.bg-warning')).toBeInTheDocument();
    expect(container.querySelector('.bg-primary')).not.toBeInTheDocument();
  });
});
