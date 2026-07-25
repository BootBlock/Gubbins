import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import type { TagWithCount } from '@/db/repositories';

vi.mock('@tanstack/react-router', () => ({
  Link: ({
    children,
    ...props
  }: React.AnchorHTMLAttributes<HTMLAnchorElement> & { to?: string; children?: React.ReactNode }) => (
    <a {...props}>{children}</a>
  ),
}));

vi.mock('@/components/BrandMark', () => ({ BrandMark: () => <span data-testid="brand-mark" /> }));

// The export menu owns its own download + toast machinery (covered by its own tests) and needs a
// ToastProvider; here we only care that the screen offers it.
vi.mock('@/features/export/TabularExportMenu', () => ({
  TabularExportMenu: ({ disabled, testIdPrefix }: { disabled?: boolean; testIdPrefix: string }) => (
    <button type="button" data-testid={testIdPrefix} disabled={disabled}>
      Export
    </button>
  ),
}));

// The global nav has its own suite; stub it so this screen needs no router/alerts context.
vi.mock('@/components/nav/AppNav', () => ({
  AppNav: () => <button type="button" data-testid="app-nav" aria-label="Navigation menu" />,
}));

vi.mock('@/components/icons', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/components/icons')>();
  return Object.fromEntries(Object.keys(actual).map((k) => [k, () => <span data-testid={`icon-${k}`} />]));
});

vi.mock('@/lib/useFormatters', () => ({
  useFormatters: () => ({
    currency: (v: number) => `£${v.toFixed(2)}`,
    quantity: (v: number) => String(v),
    date: () => '01 Jan 2026',
  }),
}));

// ─── controlled query stubs ───────────────────────────────────────────────────

let dictionaryState: { isLoading: boolean; isError: boolean; data?: { rows: TagWithCount[] } } = {
  isLoading: false,
  isError: false,
  data: { rows: [] },
};
let countState = 0;
let allTagsState: TagWithCount[] = [];
const refetch = vi.fn();
const requestedPages: { page: number; pageSize: number }[] = [];
/** Every narrowing the screen has asked the *query* for, newest last (issue #137). */
const requestedBrowse: { search?: string; sort?: string }[] = [];
/** Every filter the count query was given — it must track the list's, or the pager lies. */
const requestedCountFilters: string[] = [];

vi.mock('../inventory/tags', () => ({
  // The export's read-everything walk (issue #132); never invoked here, as the menu is stubbed.
  readTagDictionaryPage: vi.fn(() => vi.fn()),
  useTagDictionary: (page: number, pageSize: number, browse: { search?: string; sort?: string } = {}) => {
    requestedPages.push({ page, pageSize });
    requestedBrowse.push(browse);
    return { ...dictionaryState, refetch };
  },
  useTagCount: (search = '') => {
    requestedCountFilters.push(search);
    return { data: countState };
  },
  // The merge picker reads the whole dictionary, never the page on screen.
  useTagNames: () => ({ data: { rows: allTagsState } }),
  useTagSuggestions: (q: string) => ({
    data: allTagsState.filter((x) => x.name.toLowerCase().startsWith(q.trim().toLowerCase())),
  }),
  useTagManagement: () => ({
    create: { mutate: vi.fn(), isPending: false },
    rename: { mutate: vi.fn(), isPending: false },
    remove: { mutate: vi.fn(), isPending: false },
    merge: { mutate: vi.fn(), isPending: false },
  }),
}));

import { usePreferencesStore } from '@/state/stores/usePreferencesStore';
import { TagsScreen } from './TagsScreen';

const tag = (id: string, name: string, itemCount = 0, locationCount = 0): TagWithCount => ({
  id,
  name,
  updatedAt: 0,
  itemCount,
  locationCount,
});

beforeEach(() => {
  requestedPages.length = 0;
  requestedBrowse.length = 0;
  requestedCountFilters.length = 0;
  refetch.mockClear();
  countState = 0;
  allTagsState = [];
  dictionaryState = { isLoading: false, isError: false, data: { rows: [] } };
  usePreferencesStore.setState({ paginateLists: false, defaultPageSize: 50 });
});
afterEach(cleanup);

describe('TagsScreen (issue #84)', () => {
  it('reports a failed load instead of the empty state', () => {
    // The original bug's visible symptom: a failed read rendered "No tags yet", which reads
    // like success and hides a real error.
    dictionaryState = { isLoading: false, isError: true };
    render(<TagsScreen />);

    expect(screen.getByRole('alert').textContent).toContain('couldn’t be loaded');
    expect(screen.queryByText(/No tags yet/)).toBeNull();
  });

  it('offers a retry that refetches', () => {
    dictionaryState = { isLoading: false, isError: true };
    render(<TagsScreen />);

    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(refetch).toHaveBeenCalled();
  });

  it('shows the empty state only when the load genuinely returned nothing', () => {
    render(<TagsScreen />);
    expect(screen.getByText(/No tags yet/)).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('lists tags with their item and location usage', () => {
    dictionaryState = {
      isLoading: false,
      isError: false,
      data: { rows: [tag('a', 'fragile', 3, 1), tag('b', 'spare')] },
    };
    countState = 2;
    render(<TagsScreen />);

    expect(screen.getByRole('button', { name: /fragile/ }).textContent).toContain('3 items');
    expect(screen.getByRole('button', { name: /fragile/ }).textContent).toContain('1 location');
    // A tag on nothing reads as "Unused" rather than "0 items".
    expect(screen.getByRole('button', { name: /spare/ }).textContent).toContain('Unused');
  });

  it('hides pagination when the preference is off', () => {
    dictionaryState = { isLoading: false, isError: false, data: { rows: [tag('a', 'fragile')] } };
    countState = 500;
    render(<TagsScreen />);
    expect(screen.queryByTestId('tags-pagination')).toBeNull();
  });

  it('pages server-side so tags beyond the first page stay reachable', () => {
    usePreferencesStore.setState({ paginateLists: true, defaultPageSize: 10 });
    dictionaryState = { isLoading: false, isError: false, data: { rows: [tag('a', 'fragile')] } };
    countState = 42; // 5 pages at 10/page
    render(<TagsScreen />);

    expect(screen.getByTestId('tags-pagination')).toBeTruthy();
    // The denominator comes from the total count, not the length of the page on screen.
    expect(screen.getByRole('button', { name: 'Page 5' })).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Page 3' }));
    // Crucially the *query* moves to page 3 — it is not a client-side slice of one capped read.
    expect(requestedPages.at(-1)).toEqual({ page: 3, pageSize: 10 });
  });

  it('says how many tags are unreachable when pagination is off', () => {
    dictionaryState = { isLoading: false, isError: false, data: { rows: [tag('a', 'fragile')] } };
    countState = 150;
    render(<TagsScreen />);
    expect(screen.getByTestId('tags-truncated').textContent).toContain('149');
  });

  it('keeps the list usable when the count query fails', () => {
    // Falls back to the rows in hand rather than reporting zero, which would strip the pager.
    usePreferencesStore.setState({ paginateLists: true, defaultPageSize: 10 });
    countState = undefined as unknown as number;
    dictionaryState = { isLoading: false, isError: false, data: { rows: [tag('a', 'fragile')] } };
    render(<TagsScreen />);
    expect(screen.getByRole('button', { name: /fragile/ })).toBeTruthy();
  });

  it('offers merge targets from the whole dictionary, not just the current page', () => {
    // Regression: feeding the dialog from the visible page made it impossible to fold a typo
    // into its correct spelling whenever the two sorted onto different pages.
    usePreferencesStore.setState({ paginateLists: true, defaultPageSize: 1 });
    dictionaryState = { isLoading: false, isError: false, data: { rows: [tag('a', 'fragil')] } };
    allTagsState = [tag('a', 'fragil'), tag('z', 'fragile')];
    countState = 2;
    render(<TagsScreen />);

    fireEvent.click(screen.getByRole('button', { name: /fragil/ }));
    const picker = screen.getByRole('combobox', { name: 'Tag to merge into' });
    fireEvent.click(picker);
    // "fragile" is on page 2, yet it must still be offered as a merge target.
    expect(screen.getAllByRole('option').map((o) => o.textContent)).toContain('fragile');
  });
});

/**
 * The tag dictionary can be taken away as a file (issue #132). The menu is stubbed (its download +
 * toast machinery has its own suite), so these assert what this screen owns: that it offers the
 * control, and gates it on the dictionary having something in it.
 */
describe('TagsScreen — export', () => {
  it('offers an export for the tag dictionary', () => {
    dictionaryState = { isLoading: false, isError: false, data: { rows: [tag('a', 'fragile')] } };
    countState = 1;
    render(<TagsScreen />);
    expect(screen.getByTestId('export-tags')).not.toBeDisabled();
  });

  it('disables it while the dictionary is empty', () => {
    render(<TagsScreen />);
    expect(screen.getByTestId('export-tags')).toBeDisabled();
  });
});

describe('TagsScreen — filtering and sorting the dictionary (issue #137)', () => {
  const two = {
    isLoading: false,
    isError: false,
    data: { rows: [tag('a', 'fragile', 3, 1), tag('b', 'spare')] },
  };

  it('asks the query to filter, rather than sieving the page it already holds', () => {
    dictionaryState = two;
    countState = 2;
    render(<TagsScreen />);

    fireEvent.change(screen.getByTestId('tags-search'), { target: { value: 'frag' } });

    // The term reaches the list query *and* the count behind the pager — a count left on the
    // whole dictionary would size the page strip for a set the filter can never fill.
    expect(requestedBrowse.at(-1)?.search).toBe('frag');
    expect(requestedCountFilters.at(-1)).toBe('frag');
  });

  it('returns to the first page when the filter changes', () => {
    // The filtered set stays five pages long, so page 3 is still a valid page afterwards and
    // clamping alone would leave the user exactly where they were, part-way down the matches.
    usePreferencesStore.setState({ paginateLists: true, defaultPageSize: 10 });
    dictionaryState = two;
    countState = 42;
    render(<TagsScreen />);

    fireEvent.click(screen.getByRole('button', { name: 'Page 3' }));
    expect(requestedPages.at(-1)?.page).toBe(3);

    fireEvent.change(screen.getByTestId('tags-search'), { target: { value: 'frag' } });
    expect(requestedPages.at(-1)?.page).toBe(1);
  });

  it('re-orders through the query, leaving the count alone', () => {
    dictionaryState = two;
    countState = 2;
    render(<TagsScreen />);

    fireEvent.click(screen.getByTestId('tags-sort'));
    fireEvent.click(screen.getByRole('option', { name: 'Least used first' }));

    expect(requestedBrowse.at(-1)?.sort).toBe('USAGE_ASC');
    // Re-ordering the same set does not change how many there are.
    expect(requestedCountFilters.at(-1)).toBe('');
  });

  it('says a filter emptied the list rather than claiming there are no tags', () => {
    dictionaryState = { isLoading: false, isError: false, data: { rows: [] } };
    countState = 0;
    render(<TagsScreen />);
    // Nothing to filter, so the box isn't offered and the genuine empty state stands.
    expect(screen.queryByTestId('tags-search')).toBeNull();
    expect(screen.getByTestId('tags-empty').textContent).toContain('No tags yet');

    // With tags present but none matching, the copy names the query instead.
    cleanup();
    dictionaryState = two;
    countState = 2;
    render(<TagsScreen />);
    // The filtered read comes back empty, as the repository's would for a term nothing matches.
    dictionaryState = { isLoading: false, isError: false, data: { rows: [] } };
    countState = 0;
    fireEvent.change(screen.getByTestId('tags-search'), { target: { value: 'zzz' } });

    expect(screen.getByTestId('tags-empty').textContent).toContain('zzz');
    expect(screen.getByTestId('tags-empty').textContent).not.toContain('No tags yet');
    // The filter stays reachable, or there would be no way back to the dictionary.
    expect(screen.getByTestId('tags-search')).toBeTruthy();
  });

  it('announces how many tags match, but stays silent when nothing is filtered', () => {
    dictionaryState = two;
    countState = 2;
    render(<TagsScreen />);
    const live = screen.getByTestId('tags-count-live');
    expect(live.getAttribute('role')).toBe('status');
    expect(live.textContent).toBe('');

    countState = 1;
    fireEvent.change(screen.getByTestId('tags-search'), { target: { value: 'frag' } });
    expect(live.textContent).toBe('1 tag matches your filter.');
  });
});
