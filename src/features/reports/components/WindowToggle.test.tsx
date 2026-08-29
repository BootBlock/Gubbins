import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { restoreSegmentLayout, stubSegmentLayout } from '@/test/segment-layout';
import { makeFormatters } from '@/lib/format';
import { ANALYTICS_WINDOWS } from '../analytics-windows';
import { WindowToggle } from './WindowToggle';

/** The class that ties a label's recolour to the pill's own 1s travel. */
const SLOW_LABEL = 'gubbins-sliding-indicator-label';

function setup(value: number = ANALYTICS_WINDOWS[0]!) {
  const onChange = vi.fn();
  const view = render(
    <WindowToggle value={value} onChange={onChange} formatters={makeFormatters('en-GB', 'GBP')} />,
  );
  const rerenderWith = (next: number) =>
    view.rerender(
      <WindowToggle value={next} onChange={onChange} formatters={makeFormatters('en-GB', 'GBP')} />,
    );
  return { ...view, onChange, rerenderWith };
}

/** The button for a window, by the label the control renders. */
function option(days: number) {
  return screen.getByRole('button', { name: `${days}d` });
}

function pill(container: HTMLElement) {
  return container.querySelector('.gubbins-sliding-indicator');
}

describe('WindowToggle', () => {
  beforeEach(stubSegmentLayout);
  afterEach(restoreSegmentLayout);

  it('reports the window the user picks', () => {
    const { onChange } = setup(ANALYTICS_WINDOWS[0]);
    fireEvent.click(option(ANALYTICS_WINDOWS[2]!));
    expect(onChange).toHaveBeenCalledWith(ANALYTICS_WINDOWS[2]);
  });

  it('draws the selection as a pill over the selected window', () => {
    const { container } = setup(ANALYTICS_WINDOWS[1]);
    expect(pill(container)).toHaveStyle({ transform: 'translateX(50px)', width: '50px' });
    // The surface is the pill's, so the button does not paint one of its own.
    expect(option(ANALYTICS_WINDOWS[1]!).className).not.toContain('bg-primary');
  });

  it('slides the pill to the newly selected window', () => {
    const { container, rerenderWith } = setup(ANALYTICS_WINDOWS[0]);
    rerenderWith(ANALYTICS_WINDOWS[3]!);
    expect(pill(container)).toHaveStyle({ transform: 'translateX(150px)' });
  });

  it('recolours both ends of the journey on the pill timing', () => {
    const { rerenderWith } = setup(ANALYTICS_WINDOWS[0]);
    rerenderWith(ANALYTICS_WINDOWS[1]!);

    // The window being left keeps its light label while the pill is still over it, and the one
    // being landed on does not go light before the pill arrives. A stock `transition-colors`
    // on either would finish in ~150ms of the pill's 1s travel.
    expect(option(ANALYTICS_WINDOWS[0]!).className).toContain(SLOW_LABEL);
    expect(option(ANALYTICS_WINDOWS[1]!).className).toContain(SLOW_LABEL);
    // Every other window keeps the brisk transition, so hover answers immediately.
    expect(option(ANALYTICS_WINDOWS[2]!).className).toContain('transition-colors');
  });

  it('hands the window it left back to the brisk transition once the pill lands', () => {
    const { container, rerenderWith } = setup(ANALYTICS_WINDOWS[0]);
    rerenderWith(ANALYTICS_WINDOWS[1]!);

    fireEvent.transitionEnd(pill(container)!);
    expect(option(ANALYTICS_WINDOWS[0]!).className).toContain('transition-colors');
    expect(option(ANALYTICS_WINDOWS[0]!).className).not.toContain(SLOW_LABEL);
  });

  it('paints the selected window itself where nothing can be measured', () => {
    restoreSegmentLayout();
    const { container } = setup(ANALYTICS_WINDOWS[1]);
    expect(pill(container)).toBeNull();
    expect(option(ANALYTICS_WINDOWS[1]!).className).toContain('bg-primary');
  });
});
