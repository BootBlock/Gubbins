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

vi.mock('../inventory/tags', () => ({
  // The export's read-everything walk (issue #132); never invoked here, as the menu is stubbed.
  readTagDictionaryPage: vi.fn(),
  useTagDictionary: (page: number, pageSize: number) => {
    requestedPages.push({ page, pageSize });
    return { ...dictionaryState, refetch };
  },
  useTagCount: () => ({ data: countState }),
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
