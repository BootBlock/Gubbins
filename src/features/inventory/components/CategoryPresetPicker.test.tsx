import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

/**
 * Behaviour tests for the {@link CategoryPresetPickerDialog} — the browsable, searchable
 * preset library. This pins the redesign's decision logic: the sections rail scoping the
 * rows pane, cross-library search (with its hop to "All presets" and live rail counts),
 * the clear-search affordance, the two-role Escape (clear the filter vs cancel the
 * dialog), and the idempotent import path. Per the component-test conventions
 * `../categories` and both hooks the dialog uses are mocked.
 */

const h = vi.hoisted(() => ({
  createCategoryAsync: vi.fn(),
  addFieldAsync: vi.fn(),
}));

vi.mock('../categories', () => ({
  useCreateCategory: () => ({ mutateAsync: h.createCategoryAsync, isPending: false }),
  useAddCategoryField: () => ({ mutateAsync: h.addFieldAsync, isPending: false }),
}));

import { CategoryPresetPickerDialog } from './CategoryPresetPicker';
import { CATEGORY_PRESETS } from '../category-presets';

// Counts derived from the registry, so growing the preset library never breaks these tests.
const TOTAL = CATEGORY_PRESETS.length;
const WORKSHOP = CATEGORY_PRESETS.filter((p) => p.sectionId === 'workshop').length;

function setup(props: Partial<React.ComponentProps<typeof CategoryPresetPickerDialog>> = {}) {
  const onClose = vi.fn();
  const onImported = vi.fn();
  const user = userEvent.setup();
  h.createCategoryAsync.mockReset().mockResolvedValue({ id: 'cat-new' });
  h.addFieldAsync.mockReset().mockResolvedValue(undefined);
  render(
    <CategoryPresetPickerDialog
      open
      onClose={onClose}
      existingNames={[]}
      onImported={onImported}
      {...props}
    />,
  );
  return { onClose, onImported, user };
}

const search = () => screen.getByRole('textbox', { name: 'Search presets' });
const sectionButton = (name: RegExp | string) => screen.getByRole('button', { name });

afterEach(cleanup);

describe('CategoryPresetPickerDialog — browsing by section', () => {
  it('opens on "All presets" with every section heading and rows from several sections', () => {
    setup();
    expect(sectionButton(`All presets — ${TOTAL} presets`)).toHaveAttribute('aria-current', 'true');
    // Grouped view: section headings render alongside rows from different sections.
    expect(screen.getByRole('heading', { name: 'Workshop' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Collectibles' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Add Tools preset' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Add Battery preset' })).toBeInTheDocument();
  });

  it('narrows the rows pane to the clicked section', async () => {
    const { user } = setup();
    await user.click(sectionButton(`Workshop — ${WORKSHOP} presets`));

    expect(sectionButton(`Workshop — ${WORKSHOP} presets`)).toHaveAttribute('aria-current', 'true');
    expect(sectionButton(`All presets — ${TOTAL} presets`)).not.toHaveAttribute('aria-current');
    expect(screen.getByRole('button', { name: 'Add Tools preset' })).toBeInTheDocument();
    // Battery is filed under Electronics, so it leaves the pane…
    expect(screen.queryByRole('button', { name: 'Add Battery preset' })).not.toBeInTheDocument();
    // …and the single-section view drops the group headings.
    expect(screen.queryByRole('heading', { name: 'Workshop' })).not.toBeInTheDocument();
  });

  it('shows each row with its description and a capped selection of field chips', () => {
    setup();
    // Tools (4 fields) shows them all; Book (7 fields) collapses the tail into "+2 more".
    expect(
      screen.getByText('Serialised, loanable equipment — tracked one-by-one with a calibration record.'),
    ).toBeInTheDocument();
    expect(screen.getByText('Calibration certificate')).toBeInTheDocument();
    const bookRow = screen.getByRole('button', { name: 'Add Book preset' });
    expect(within(bookRow).getByText('+2 more')).toBeInTheDocument();
    expect(within(bookRow).queryByText('Rating')).not.toBeInTheDocument();
  });
});

describe('CategoryPresetPickerDialog — search', () => {
  it('filters the rows across the whole library and reports the count', async () => {
    const { user } = setup();
    await user.click(sectionButton(`Workshop — ${WORKSHOP} presets`));
    await user.type(search(), 'isbn');

    // Searching hops the scope back to All so the Book match (Media) is visible…
    expect(screen.getByRole('button', { name: 'Add Book preset' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Add Tools preset' })).not.toBeInTheDocument();
    expect(screen.getByText('1 preset matches your search')).toBeInTheDocument();
    // …and the rail shows live per-section match counts.
    expect(sectionButton(/Media — 1 preset$/)).toBeInTheDocument();
    expect(sectionButton(/Workshop — 0 presets/)).toBeInTheDocument();
  });

  it('reports a no-match search', async () => {
    const { user } = setup();
    await user.type(search(), 'zzzz');
    expect(screen.getByText('No presets match “zzzz”.')).toBeInTheDocument();
  });

  it('shows the clear button only while there is text, and clearing restores the library', async () => {
    const { user } = setup();
    expect(screen.queryByRole('button', { name: 'Clear search' })).not.toBeInTheDocument();

    await user.type(search(), 'isbn');
    await user.click(screen.getByRole('button', { name: 'Clear search' }));

    expect(search()).toHaveValue('');
    expect(search()).toHaveFocus();
    expect(screen.queryByRole('button', { name: 'Clear search' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Add Tools preset' })).toBeInTheDocument();
  });

  it('clears the filter (and keeps the dialog open) on Escape from a non-empty search box', async () => {
    const { onClose, user } = setup();
    await user.type(search(), 'isbn');

    await user.keyboard('{Escape}');

    expect(search()).toHaveValue('');
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Add Tools preset' })).toBeInTheDocument();
  });

  it('cancels the dialog on Escape from an empty search box', async () => {
    const { onClose, user } = setup();
    search().focus();

    await user.keyboard('{Escape}');

    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe('CategoryPresetPickerDialog — importing', () => {
  it('imports a clicked preset through the ordinary create/add-field path and reports the new id', async () => {
    const { onImported, user } = setup();
    await user.click(screen.getByRole('button', { name: 'Add Tools preset' }));

    await waitFor(() =>
      expect(h.createCategoryAsync).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'Tools', defaultTrackingMode: 'SERIALISED' }),
      ),
    );
    await waitFor(() => expect(h.addFieldAsync).toHaveBeenCalledTimes(4));
    await waitFor(() => expect(onImported).toHaveBeenCalledWith('cat-new'));
  });

  it('marks an already-imported preset as Added and disables it (idempotent — no duplicate)', () => {
    setup({ existingNames: ['  tools  '] });
    expect(screen.getByRole('button', { name: 'Tools preset already added' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Add Battery preset' })).toBeEnabled();
  });

  it('surfaces a failed import in an alert instead of silently reverting', async () => {
    const { onImported, user } = setup();
    h.createCategoryAsync.mockRejectedValue(new Error('A category named "Tools" exists.'));

    await user.click(screen.getByRole('button', { name: 'Add Tools preset' }));

    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent(
        'The Tools preset could not be added. A category named "Tools" exists.',
      ),
    );
    expect(onImported).not.toHaveBeenCalled();
    // The row is usable again (not stuck on Adding…).
    expect(screen.getByRole('button', { name: 'Add Tools preset' })).toBeEnabled();
  });
});

describe('CategoryPresetPickerDialog — rail keyboard navigation', () => {
  it('moves selection and focus with the arrow keys (roving tab stop)', async () => {
    const { user } = setup();
    sectionButton(`All presets — ${TOTAL} presets`).focus();

    await user.keyboard('{ArrowDown}');

    const workshop = sectionButton(`Workshop — ${WORKSHOP} presets`);
    expect(workshop).toHaveAttribute('aria-current', 'true');
    expect(workshop).toHaveFocus();
    // Selection followed focus: the rows pane narrowed to Workshop.
    expect(screen.queryByRole('button', { name: 'Add Battery preset' })).not.toBeInTheDocument();

    await user.keyboard('{ArrowUp}');
    expect(sectionButton(`All presets — ${TOTAL} presets`)).toHaveFocus();
  });
});
