import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SegmentedRadioGroup } from './segmented-radio-group';
import { restoreSegmentLayout, setSegmentScale, stubSegmentLayout } from '@/test/segment-layout';
import { useSlidingIndicator } from './use-sliding-indicator';

/** Three options, each declaring the box a real browser would have given it. */
const BOXES = [
  { left: 2, width: 40 },
  { left: 44, width: 60 },
  { left: 106, width: 30 },
];

function Control({ selected }: { selected: number }) {
  const indicator = useSlidingIndicator<HTMLButtonElement>(selected, BOXES.length);
  return (
    <div ref={indicator.containerRef} data-testid="control">
      {indicator.geometry ? (
        <span
          data-testid="pill"
          className={`gubbins-sliding-indicator ${indicator.settled ? 'is-settled' : ''}`}
          style={{
            width: `${indicator.geometry.width}px`,
            transform: `translateX(${indicator.geometry.left}px)`,
          }}
        />
      ) : null}
      {BOXES.map((box, index) => (
        <button
          key={index}
          type="button"
          ref={indicator.registerOption(index)}
          data-stub-left={box.left}
          data-stub-width={box.width}
        >
          option {index}
        </button>
      ))}
    </div>
  );
}

describe('useSlidingIndicator', () => {
  beforeEach(stubSegmentLayout);
  afterEach(restoreSegmentLayout);

  it('measures the selected option, so the pill is drawn over it', () => {
    render(<Control selected={1} />);
    expect(screen.getByTestId('pill')).toHaveStyle({
      width: '60px',
      transform: 'translateX(44px)',
    });
  });

  it('moves the pill to the newly selected option', () => {
    const { rerender } = render(<Control selected={0} />);
    expect(screen.getByTestId('pill')).toHaveStyle({ transform: 'translateX(2px)' });

    rerender(<Control selected={2} />);
    expect(screen.getByTestId('pill')).toHaveStyle({
      width: '30px',
      transform: 'translateX(106px)',
    });
  });

  it('only animates after the first frame, so the pill does not fly in on mount', async () => {
    render(<Control selected={1} />);
    // The very first paint places the pill without a transition…
    expect(screen.getByTestId('pill').className).not.toContain('is-settled');
    // …and a frame later it is armed for the selections the user makes.
    await waitFor(() => expect(screen.getByTestId('pill').className).toContain('is-settled'));
  });

  it('measures nothing where the control has no layout', () => {
    restoreSegmentLayout();
    render(<Control selected={1} />);
    expect(screen.queryByTestId('pill')).toBeNull();
  });

  it('measures in local pixels through an ancestor scale, so a dialog entrance cannot shrink the pill', () => {
    // A Modal's panel animates in from `scale(0.96)`; a mount-time rect is 4% short of the
    // pixels the pill is positioned in.
    setSegmentScale(0.96);
    render(<Control selected={1} />);
    expect(screen.getByTestId('pill')).toHaveStyle({
      width: '60px',
      transform: 'translateX(44px)',
    });
  });

  it('does not mistake a fractional layout width for a transform', () => {
    // `offsetWidth` is a whole pixel, so an untransformed 400.4px-wide container reports a
    // "scale" of 1.001. Dividing by that would hand back the half-pixel error the rects were
    // measured to avoid, so the measurement has to come through untouched.
    setSegmentScale(1.001);
    render(<Control selected={1} />);
    expect(screen.getByTestId('pill')).toHaveStyle({
      width: '60.06px',
      transform: 'translateX(44.05px)',
    });
  });

  it('re-measures when the control resizes', async () => {
    const observers: (() => void)[] = [];
    vi.stubGlobal(
      'ResizeObserver',
      class {
        constructor(callback: () => void) {
          observers.push(callback);
        }
        observe() {}
        disconnect() {}
      },
    );
    try {
      render(<Control selected={0} />);
      expect(screen.getByTestId('pill')).toHaveStyle({ width: '40px' });

      // A reflow widens the first option; the hook hears it from the observer, not a re-render.
      screen.getByRole('button', { name: 'option 0' }).dataset.stubWidth = '90';
      for (const notify of observers) notify();

      await waitFor(() => expect(screen.getByTestId('pill')).toHaveStyle({ width: '90px' }));
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('follows a reflow without animating, so the pill never trails the segments', async () => {
    const observers: (() => void)[] = [];
    vi.stubGlobal(
      'ResizeObserver',
      class {
        constructor(callback: () => void) {
          observers.push(callback);
        }
        observe() {}
        disconnect() {}
      },
    );
    try {
      render(<Control selected={0} />);
      await waitFor(() => expect(screen.getByTestId('pill').className).toContain('is-settled'));

      // The layout moved, not the selection: the segments jump, so the pill jumps with them.
      screen.getByRole('button', { name: 'option 0' }).dataset.stubWidth = '90';
      act(() => {
        for (const notify of observers) notify();
      });
      expect(screen.getByTestId('pill').className).not.toContain('is-settled');

      // …and it is armed again for the next selection the user makes.
      await waitFor(() => expect(screen.getByTestId('pill').className).toContain('is-settled'));
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe('SegmentedRadioGroup sliding selection', () => {
  beforeEach(stubSegmentLayout);
  afterEach(restoreSegmentLayout);

  function Group() {
    const [value, setValue] = useState('sm');
    return (
      <SegmentedRadioGroup
        label="Size"
        options={[
          { value: 'sm', label: 'Small' },
          { value: 'lg', label: 'Large' },
        ]}
        value={value}
        onChange={setValue}
      />
    );
  }

  it('paints the selection on the moving pill, not on the segment', () => {
    const { container } = render(<Group />);
    const pill = container.querySelector('.gubbins-sliding-indicator');
    expect(pill).toHaveStyle({ transform: 'translateX(0px)', width: '50px' });
    // The selected segment no longer carries the surface itself — the pill does.
    expect(screen.getByRole('radio', { name: 'Small' }).className).not.toContain('bg-card-elevated');
  });

  it('slides the pill to the segment the user picks', () => {
    const { container } = render(<Group />);
    fireEvent.click(screen.getByRole('radio', { name: 'Large' }));
    expect(container.querySelector('.gubbins-sliding-indicator')).toHaveStyle({
      transform: 'translateX(50px)',
    });
  });

  it('falls back to painting the selected segment where nothing can be measured', () => {
    restoreSegmentLayout();
    const { container } = render(<Group />);
    expect(container.querySelector('.gubbins-sliding-indicator')).toBeNull();
    expect(screen.getByRole('radio', { name: 'Small' }).className).toContain('bg-card-elevated');
  });
});
