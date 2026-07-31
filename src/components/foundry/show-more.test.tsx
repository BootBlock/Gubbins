import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ShowMore } from './show-more';

function setup(overrides: Partial<React.ComponentProps<typeof ShowMore>> = {}) {
  const onShowMore = vi.fn();
  const onShowLess = vi.fn();
  const { rerender, ...view } = render(
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
  return { ...view, rerender, onShowMore, onShowLess };
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
    // Each name comes from its own catalog key opening with the visible label, so WCAG 2.5.3
    // label-in-name holds in every language rather than only where concatenation reads.
    expect(screen.getByRole('button', { name: 'Show more: categories' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Show fewer: categories' })).toBeInTheDocument();
  });

  it('hands focus to the collapse control when the last reveal unmounts "show more"', () => {
    // Otherwise the click that finishes the list drops focus to <body>, stranding a keyboard
    // user at the top of the document exactly when they asked to see the rest.
    const { rerender, onShowMore } = setup({ shown: 24, total: 30, expanded: true });
    const more = screen.getByTestId('more-more');
    more.focus();
    fireEvent.click(more);
    expect(onShowMore).toHaveBeenCalled();

    rerender(
      <ShowMore
        shown={30}
        total={30}
        label="categories"
        expanded
        onShowMore={onShowMore}
        onShowLess={vi.fn()}
        data-testid="more"
      />,
    );
    expect(screen.queryByTestId('more-more')).not.toBeInTheDocument();
    expect(document.activeElement).toBe(screen.getByTestId('more-less'));
  });
});
