import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ShowMore } from './show-more';

function setup(overrides: Partial<React.ComponentProps<typeof ShowMore>> = {}) {
  const onShowMore = vi.fn();
  const onShowLess = vi.fn();
  const view = render(
    <ShowMore
      shown={12}
      total={40}
      label="categories"
      expanded={false}
      onShowMore={onShowMore}
      onShowLess={onShowLess}
      data-testid="more"
      {...overrides}
    />,
  );
  return { ...view, onShowMore, onShowLess };
}

describe('ShowMore', () => {
  it('states how many of how many are on screen', () => {
    setup();
    expect(screen.getByTestId('more-summary')).toHaveTextContent('Showing 12 of 40 categories');
  });

  it('announces the count politely, so revealing more is reported', () => {
    setup();
    const summary = screen.getByTestId('more-summary');
    expect(summary).toHaveAttribute('role', 'status');
    expect(summary).toHaveAttribute('aria-live', 'polite');
  });

  it('offers only "show more" while collapsed, and calls back when used', () => {
    const { onShowMore } = setup();
    expect(screen.queryByTestId('more-less')).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId('more-more'));
    expect(onShowMore).toHaveBeenCalledTimes(1);
  });

  it('offers collapsing once expanded', () => {
    const { onShowLess } = setup({ shown: 24, expanded: true });
    fireEvent.click(screen.getByTestId('more-less'));
    expect(onShowLess).toHaveBeenCalledTimes(1);
  });

  it('keeps the way back when everything is shown, but drops "show more"', () => {
    setup({ shown: 40, expanded: true });
    expect(screen.queryByTestId('more-more')).not.toBeInTheDocument();
    expect(screen.getByTestId('more-less')).toBeInTheDocument();
    expect(screen.getByTestId('more-summary')).toHaveTextContent('Showing 40 of 40 categories');
  });

  it('renders nothing when the list is already whole and unexpanded', () => {
    const { container } = setup({ shown: 8, total: 8 });
    expect(container).toBeEmptyDOMElement();
  });

  it('names the list in each control so several on one screen are told apart', () => {
    setup({ shown: 24, expanded: true });
    // The visible label starts the accessible name (WCAG 2.5.3 label-in-name), with the noun
    // appended for assistive tech.
    expect(screen.getByRole('button', { name: 'Show more categories' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Show fewer categories' })).toBeInTheDocument();
  });
});
