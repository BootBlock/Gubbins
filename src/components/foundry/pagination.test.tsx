import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { Pagination } from './pagination';

const PRESETS = [10, 25, 50, 100];

function setup(overrides: Partial<React.ComponentProps<typeof Pagination>> = {}) {
  const onPageChange = vi.fn();
  const onPageSizeChange = vi.fn();
  render(
    <Pagination
      page={2}
      pageCount={5}
      onPageChange={onPageChange}
      pageSize={10}
      onPageSizeChange={onPageSizeChange}
      pageSizeOptions={PRESETS}
      minPageSize={5}
      maxPageSize={100}
      totalItems={48}
      data-testid="pager"
      {...overrides}
    />,
  );
  return { onPageChange, onPageSizeChange };
}

describe('Pagination', () => {
  it('renders a labelled navigation landmark with an item summary', () => {
    setup();
    expect(screen.getByRole('navigation', { name: 'Pagination' })).toBeInTheDocument();
    // Page 2 of 10-per-page over 48 items ⇒ items 11–20.
    expect(screen.getByTestId('pager-summary')).toHaveTextContent('11–20 of 48');
  });

  it('renders nothing when there is one page or fewer', () => {
    const { container } = render(
      <Pagination
        page={1}
        pageCount={1}
        onPageChange={vi.fn()}
        pageSize={10}
        onPageSizeChange={vi.fn()}
        pageSizeOptions={PRESETS}
        minPageSize={5}
        maxPageSize={100}
      />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('marks the current page with aria-current and steps with Previous/Next', () => {
    const { onPageChange } = setup();
    expect(screen.getByRole('button', { name: 'Page 2, current page' })).toHaveAttribute(
      'aria-current',
      'page',
    );

    fireEvent.click(screen.getByRole('button', { name: 'Previous page' }));
    expect(onPageChange).toHaveBeenCalledWith(1);

    fireEvent.click(screen.getByRole('button', { name: 'Next page' }));
    expect(onPageChange).toHaveBeenCalledWith(3);
  });

  it('jumps to a chosen page number', () => {
    const { onPageChange } = setup();
    fireEvent.click(screen.getByRole('button', { name: 'Page 4' }));
    expect(onPageChange).toHaveBeenCalledWith(4);
  });

  it('disables Previous on the first page and Next on the last', () => {
    setup({ page: 1 });
    expect(screen.getByRole('button', { name: 'Previous page' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Next page' })).not.toBeDisabled();
  });

  it('commits a preset page size immediately when picked/typed exactly', () => {
    const { onPageSizeChange } = setup();
    const size = screen.getByRole('combobox', { name: 'Per page' });
    fireEvent.change(size, { target: { value: '25' } });
    expect(onPageSizeChange).toHaveBeenCalledWith(25);
  });

  it('commits a freely-typed page size on blur, clamped into range', () => {
    const { onPageSizeChange } = setup();
    const size = screen.getByRole('combobox', { name: 'Per page' });
    // 3 is below the floor of 5 — committing on blur clamps it up.
    fireEvent.change(size, { target: { value: '3' } });
    expect(onPageSizeChange).not.toHaveBeenCalled(); // not a preset, so not committed yet
    fireEvent.blur(size);
    expect(onPageSizeChange).toHaveBeenCalledWith(5);
  });
});
