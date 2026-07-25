/**
 * Component tests for ProjectsScreen — WCAG 4.1.3 aria-live result-count coverage
 * (Phase 64 — aria-live Tier B). Verifies that:
 *  1. The list result-count live region is always mounted before data loads.
 *  2. The region announces the correct count once projects resolve.
 *  3. The region announces the empty state when there are no projects.
 *
 * All dependencies are mocked at the module boundary so no DB or QueryClient
 * is needed. The router Link, heavy sub-components, and icons are stubbed out
 * so the test stays in happy-dom without extra providers.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { COMPACT_LAYOUT_QUERY } from '@/lib/env/device';

// ─── dependency stubs ─────────────────────────────────────────────────────────

vi.mock('@tanstack/react-router', () => ({
  Link: ({
    children,
    ...props
  }: React.AnchorHTMLAttributes<HTMLAnchorElement> & { to?: string; children?: React.ReactNode }) => (
    <a {...props}>{children}</a>
  ),
}));

vi.mock('@/components/BrandMark', () => ({
  BrandMark: () => <span data-testid="brand-mark" />,
}));

// The global nav menu has its own suite; stub it so this screen test needs no
// router/alerts context for the header.
vi.mock('@/components/nav/AppNav', () => ({
  AppNav: () => <button type="button" data-testid="app-nav" aria-label="Navigation menu" />,
}));

vi.mock('@/components/icons', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/components/icons')>();
  return Object.fromEntries(Object.keys(actual).map((k) => [k, () => <span data-testid={`icon-${k}`} />]));
});

// Stub sub-components that pull in heavy dependencies.
vi.mock('./components/CreateProjectDialog', () => ({
  CreateProjectDialog: () => null,
}));
vi.mock('./components/ImportBomDialog', () => ({
  ImportBomDialog: () => null,
}));
vi.mock('./components/ProjectDetail', () => ({
  ProjectDetail: () => <div data-testid="project-detail" />,
}));

// ─── controlled query stub ────────────────────────────────────────────────────

type ProjectRow = { id: string; name: string; lineCount: number; status: string };
type Browse = { search?: string; status?: string; sort?: string };

let projectsState: {
  isLoading: boolean;
  isError?: boolean;
  data?: { rows: ProjectRow[] };
} = {
  isLoading: true,
  isError: false,
};
/** Overrides the project total when a test needs it to disagree with the rows it supplies. */
let projectCountState: number | undefined;
const refetch = vi.fn();
/** Every narrowing the screen has asked the *query* for, newest last (issue #137). */
const requestedBrowse: Browse[] = [];
/** Every page the screen has asked the query for, newest last. */
const requestedPages: number[] = [];

/**
 * The filtering and ordering the repository would do, so the stub can prove the screen delegates
 * both rather than sieving the page it already holds. The fixture order stands in for "newest
 * first", which is what the real default sort resolves to.
 */
function applyBrowse(all: ProjectRow[], browse: Browse): ProjectRow[] {
  const term = browse.search?.trim().toLowerCase() ?? '';
  const matched = all.filter(
    (p) =>
      (term.length === 0 || p.name.toLowerCase().includes(term)) &&
      (!browse.status || p.status === browse.status),
  );
  if (browse.sort === 'NAME_ASC') return [...matched].sort((a, b) => a.name.localeCompare(b.name));
  if (browse.sort === 'NAME_DESC') return [...matched].sort((a, b) => b.name.localeCompare(a.name));
  if (browse.sort === 'OLDEST') return [...matched].reverse();
  return matched;
}

vi.mock('./projects', () => ({
  /**
   * The master list pages **server-side** (issue #149) and narrows server-side (issue #137), so
   * the stub serves pages the way the repository does: `projectsState.data.rows` is every
   * project, the filter and sort are applied to all of them, and the hook returns only the
   * requested window of what matched, capped at the repository's ceiling.
   */
  useProjects: (page = 1, pageSize = 100, browse: Browse = {}) => {
    requestedBrowse.push(browse);
    requestedPages.push(page);
    if (!projectsState.data) return { ...projectsState, refetch };
    const all = applyBrowse(projectsState.data.rows, browse);
    const limit = Math.min(pageSize, 100);
    const offset = (page - 1) * limit;
    const rows = all.slice(offset, offset + limit);
    return {
      ...projectsState,
      data: { rows, offset, limit, hasMore: offset + rows.length < all.length },
      refetch,
    };
  },
  // How many *match*, across every page — as the real filtered COUNT(*) would.
  useProjectCount: (filter: Browse = {}) => ({
    data:
      projectCountState ??
      (projectsState.data ? applyBrowse(projectsState.data.rows, filter).length : undefined),
  }),
  // Resolved from the whole set, not the page in view — that is the point of the real hook here.
  useProject: (id: string | undefined) => ({
    data: id ? projectsState.data?.rows.find((p) => p.id === id) : undefined,
  }),
}));

// ─── component under test ─────────────────────────────────────────────────────

import { ProjectsScreen } from './ProjectsScreen';
import { usePreferencesStore } from '@/state/stores/usePreferencesStore';

// ─── helpers ──────────────────────────────────────────────────────────────────

function makeProject(id: string, name: string, status = 'ACTIVE'): ProjectRow {
  return { id, name, lineCount: 0, status };
}

afterEach(cleanup);

beforeEach(() => {
  projectsState = { isLoading: true, isError: false };
  projectCountState = undefined;
  requestedBrowse.length = 0;
  requestedPages.length = 0;
  refetch.mockClear();
});

// ─── tests ────────────────────────────────────────────────────────────────────

describe('ProjectsScreen — aria-live result-count (WCAG 4.1.3, Phase 64)', () => {
  it('mounts the result-count live region before data resolves', () => {
    render(<ProjectsScreen />);
    const region = screen.getByTestId('projects-count-live');
    expect(region).toBeTruthy();
    expect(region.getAttribute('role')).toBe('status');
    expect(region.getAttribute('aria-live')).toBe('polite');
  });

  it('announces "Loading" while the query is in-flight', () => {
    projectsState = { isLoading: true };
    render(<ProjectsScreen />);
    const region = screen.getByTestId('projects-count-live');
    expect(region.textContent?.toLowerCase()).toContain('loading');
  });

  it('announces the count once projects resolve', () => {
    projectsState = {
      isLoading: false,
      data: { rows: [makeProject('p1', 'Alpha'), makeProject('p2', 'Beta')] },
    };
    render(<ProjectsScreen />);
    const region = screen.getByTestId('projects-count-live');
    expect(region.textContent).toContain('2');
    expect(region.textContent?.toLowerCase()).toContain('project');
  });

  it('uses singular form for exactly one project', () => {
    projectsState = {
      isLoading: false,
      data: { rows: [makeProject('p1', 'Solo')] },
    };
    render(<ProjectsScreen />);
    const region = screen.getByTestId('projects-count-live');
    expect(region.textContent).toContain('1 project');
    // Must NOT say "1 projects".
    expect(region.textContent).not.toContain('1 projects');
  });

  it('announces the empty state when there are no projects', () => {
    projectsState = { isLoading: false, data: { rows: [] } };
    render(<ProjectsScreen />);
    const region = screen.getByTestId('projects-count-live');
    expect(region.textContent?.toLowerCase()).toContain('no projects');
  });

  it('the live region is visually hidden (sr-only) so only screen readers receive it', () => {
    render(<ProjectsScreen />);
    const region = screen.getByTestId('projects-count-live');
    expect(region.className).toContain('sr-only');
  });
});

describe('ProjectsScreen — failed load (issue #306)', () => {
  it('reports the error instead of the "no projects yet" empty state', () => {
    projectsState = { isLoading: false, isError: true };
    render(<ProjectsScreen />);
    expect(screen.getByRole('alert').textContent).toContain('couldn’t be loaded');
    expect(screen.queryByText(/No projects yet/)).toBeNull();
  });

  it('offers a retry that refetches', () => {
    projectsState = { isLoading: false, isError: true };
    render(<ProjectsScreen />);
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(refetch).toHaveBeenCalled();
  });

  it('the count live region stays silent on failure (the alert speaks instead)', () => {
    projectsState = { isLoading: false, isError: true };
    render(<ProjectsScreen />);
    expect(screen.getByTestId('projects-count-live').textContent).toBe('');
  });
});

describe('ProjectsScreen — compact viewport (issue #147)', () => {
  afterEach(() => vi.unstubAllGlobals());

  /** Force the compact-layout query on or off for the default `matchMedia` provider. */
  function setCompact(compact: boolean) {
    vi.stubGlobal('matchMedia', (query: string) => ({
      matches: query === COMPACT_LAYOUT_QUERY ? compact : false,
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
    }));
  }

  it('keeps the master list beside the detail on a wide viewport', () => {
    setCompact(false);
    projectsState = { isLoading: false, data: { rows: [makeProject('p1', 'Alpha')] } };
    render(<ProjectsScreen />);
    expect(screen.getByRole('complementary', { name: 'Projects' })).toBeTruthy();
    expect(screen.queryByTestId('open-projects-drawer')).toBeNull();
  });

  it('replaces the master list with a drawer trigger naming the current project', () => {
    setCompact(true);
    projectsState = { isLoading: false, data: { rows: [makeProject('p1', 'Alpha')] } };
    render(<ProjectsScreen />);
    // The 256px list is gone from the flow — that room now belongs to the detail pane.
    expect(screen.queryByRole('complementary')).toBeNull();
    const trigger = screen.getByTestId('open-projects-drawer');
    // The first project is auto-selected, so the trigger doubles as the breadcrumb.
    expect(trigger.getAttribute('aria-label')).toContain('Alpha');
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
  });

  it('opens the list in a modal drawer, and picking a project closes it', async () => {
    setCompact(true);
    projectsState = {
      isLoading: false,
      data: { rows: [makeProject('p1', 'Alpha'), makeProject('p2', 'Beta')] },
    };
    render(<ProjectsScreen />);
    fireEvent.click(screen.getByTestId('open-projects-drawer'));

    const drawer = screen.getByRole('dialog', { name: 'Projects' });
    expect(drawer.getAttribute('aria-modal')).toBe('true');

    fireEvent.click(screen.getByRole('button', { name: /Beta/ }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Projects' })).toBeNull());
    // …and the trigger now names the project the detail pane switched to.
    expect(screen.getByTestId('open-projects-drawer').getAttribute('aria-label')).toContain('Beta');
  });

  it('reports "no project selected" on the trigger when the list is empty', () => {
    setCompact(true);
    projectsState = { isLoading: false, data: { rows: [] } };
    render(<ProjectsScreen />);
    expect(screen.getByTestId('open-projects-drawer').getAttribute('aria-label')).toContain(
      'No project selected',
    );
  });
});

describe('ProjectsScreen — a list longer than one read (issue #149)', () => {
  afterEach(() => {
    usePreferencesStore.setState({ paginateLists: false, defaultPageSize: 50 });
  });

  /** 130 projects — more than the repository will return in a single capped read. */
  const manyProjects = {
    isLoading: false,
    data: {
      rows: Array.from({ length: 130 }, (_, i) =>
        makeProject(`p${i}`, `Project ${String(i + 1).padStart(3, '0')}`),
      ),
    },
  };

  it('says how many projects the capped read leaves out when pagination is off', () => {
    projectsState = manyProjects;
    render(<ProjectsScreen />);

    const notice = screen.getByTestId('projects-truncated');
    expect(notice.textContent).toContain('100');
    expect(notice.textContent).toContain('30');
    expect(screen.queryByText('Project 101')).toBeNull();
  });

  it('reports the whole set in the live region, not just the page in view', () => {
    projectsState = manyProjects;
    render(<ProjectsScreen />);
    expect(screen.getByTestId('projects-count-live').textContent).toContain('130 projects');
  });

  it('reaches the projects past the first read once pagination is on', () => {
    usePreferencesStore.setState({ paginateLists: true, defaultPageSize: 100 });
    projectsState = manyProjects;
    render(<ProjectsScreen />);

    expect(screen.queryByTestId('projects-truncated')).toBeNull();
    expect(screen.getByTestId('projects-pagination-summary')).toHaveTextContent('1–100 of 130');

    fireEvent.click(screen.getByRole('button', { name: 'Next page' }));
    expect(screen.getByTestId('projects-pagination-summary')).toHaveTextContent('101–130 of 130');
    expect(screen.getByRole('button', { name: /Project 101/ })).toBeInTheDocument();
  });

  it('shows no truncation notice when every project fits in one read', () => {
    projectsState = { isLoading: false, data: { rows: [makeProject('p1', 'Alpha')] } };
    render(<ProjectsScreen />);
    expect(screen.queryByTestId('projects-truncated')).toBeNull();
  });
});

describe('ProjectsScreen — narrowing the master list (issue #137)', () => {
  /** Three projects across three statuses, in "newest first" fixture order. */
  const trio = {
    isLoading: false,
    data: {
      rows: [
        makeProject('p1', 'Desk lamp', 'COMPLETED'),
        makeProject('p2', 'Garden rover', 'ACTIVE'),
        makeProject('p3', 'Bench PSU', 'PLANNING'),
      ],
    },
  };

  /** The names currently listed, in list order. */
  function listedNames(): string[] {
    return screen
      .getAllByRole('button')
      .map((b) => b.textContent ?? '')
      .filter((text) => /Desk lamp|Garden rover|Bench PSU/.test(text))
      .map((text) => text.replace(/\s*\d+ parts?.*$/, '').trim());
  }

  /** Open a Foundry Select and choose the option with this label. */
  function chooseOption(testId: string, option: string) {
    fireEvent.click(screen.getByTestId(testId));
    fireEvent.click(screen.getByRole('option', { name: option }));
  }

  it('asks the query to search, rather than sieving the page it already holds', () => {
    projectsState = trio;
    render(<ProjectsScreen />);

    fireEvent.change(screen.getByTestId('projects-search'), { target: { value: 'rov' } });

    // The term reaches the query — which is what makes it find projects that sort past this page.
    expect(requestedBrowse.at(-1)?.search).toBe('rov');
    expect(listedNames()).toEqual(['Garden rover']);
  });

  it('narrows by status through the query too', () => {
    projectsState = trio;
    render(<ProjectsScreen />);

    chooseOption('projects-status-filter', 'Completed');

    expect(requestedBrowse.at(-1)?.status).toBe('COMPLETED');
    expect(listedNames()).toEqual(['Desk lamp']);
  });

  it('re-orders the whole set, not the rows on screen', () => {
    projectsState = trio;
    render(<ProjectsScreen />);
    expect(listedNames()).toEqual(['Desk lamp', 'Garden rover', 'Bench PSU']);

    chooseOption('projects-sort', 'Name A–Z');

    expect(requestedBrowse.at(-1)?.sort).toBe('NAME_ASC');
    expect(listedNames()).toEqual(['Bench PSU', 'Desk lamp', 'Garden rover']);
  });

  it('says a filter emptied the list, and offers the way back', () => {
    projectsState = trio;
    render(<ProjectsScreen />);

    fireEvent.change(screen.getByTestId('projects-search'), { target: { value: 'zzz' } });
    // "No projects yet" here would be a lie, and would send the user to create a duplicate.
    expect(screen.getByTestId('projects-no-matches')).toBeTruthy();
    expect(screen.queryByText(/No projects yet/)).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Clear filters' }));
    expect(listedNames()).toEqual(['Desk lamp', 'Garden rover', 'Bench PSU']);
  });

  it('announces how many projects match rather than the unfiltered total', () => {
    projectsState = trio;
    render(<ProjectsScreen />);
    expect(screen.getByTestId('projects-count-live').textContent).toContain('3 projects');

    fireEvent.change(screen.getByTestId('projects-search'), { target: { value: 'rov' } });
    expect(screen.getByTestId('projects-count-live').textContent).toBe('1 project matches your filter.');

    fireEvent.change(screen.getByTestId('projects-search'), { target: { value: 'zzz' } });
    expect(screen.getByTestId('projects-count-live').textContent).toBe('0 projects match your filter.');
  });

  it('offers no filter controls when there is nothing to filter', () => {
    projectsState = { isLoading: false, data: { rows: [] } };
    render(<ProjectsScreen />);
    expect(screen.queryByTestId('projects-search')).toBeNull();
    expect(screen.getByText('No projects yet. Create one to plan a build.')).toBeTruthy();
  });

  it('returns to the first page when the filter changes', () => {
    usePreferencesStore.setState({ paginateLists: true, defaultPageSize: 10 });
    // 60 projects — 40 matching "Alpha". Sized so the *filtered* set is still four pages long:
    // page 3 remains a valid page after filtering, so only a genuine reset gets back to the
    // first one. (Clamping to the last page would leave page 3 exactly where it was.)
    projectsState = {
      isLoading: false,
      data: {
        rows: Array.from({ length: 60 }, (_, i) =>
          makeProject(`p${i}`, `${i < 40 ? 'Alpha' : 'Beta'} ${String(i + 1).padStart(3, '0')}`),
        ),
      },
    };
    render(<ProjectsScreen />);

    fireEvent.click(screen.getByRole('button', { name: 'Page 3' }));
    expect(requestedPages.at(-1)).toBe(3);

    // Staying on page 3 would open the filtered list a third of the way down it, past every
    // match the user is most likely to have been looking for.
    fireEvent.change(screen.getByTestId('projects-search'), { target: { value: 'Alpha' } });
    expect(requestedPages.at(-1)).toBe(1);
    expect(screen.getByRole('button', { name: /Alpha 001/ })).toBeInTheDocument();

    usePreferencesStore.setState({ paginateLists: false, defaultPageSize: 50 });
  });
});

describe('ProjectsScreen — a failed load stays visible on a compact viewport (issue #306 × #147)', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('shows the error where the drawer trigger would be, not hidden behind the drawer', () => {
    vi.stubGlobal('matchMedia', (query: string) => ({
      matches: query === COMPACT_LAYOUT_QUERY,
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
    }));
    projectsState = { isLoading: false, isError: true };
    render(<ProjectsScreen />);
    expect(screen.getByRole('alert').textContent).toContain('couldn’t be loaded');
    // A trigger for a list that failed to load would only lead to an empty panel.
    expect(screen.queryByTestId('open-projects-drawer')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(refetch).toHaveBeenCalled();
  });
});
