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

vi.mock('./projects', () => ({
  /**
   * The master list pages **server-side** (issue #149), so the stub serves pages the way the
   * repository does: `projectsState.data.rows` is every project, and the hook returns only the
   * requested window of it, capped at the repository's ceiling.
   */
  useProjects: (page = 1, pageSize = 100) => {
    if (!projectsState.data) return { ...projectsState, refetch };
    const all = projectsState.data.rows;
    const limit = Math.min(pageSize, 100);
    const offset = (page - 1) * limit;
    const rows = all.slice(offset, offset + limit);
    return {
      ...projectsState,
      data: { rows, offset, limit, hasMore: offset + rows.length < all.length },
      refetch,
    };
  },
  // The total across every page. Defaults to the whole fixture, as the real COUNT(*) would.
  useProjectCount: () => ({ data: projectCountState ?? projectsState.data?.rows.length }),
  // Resolved from the whole set, not the page in view — that is the point of the real hook here.
  useProject: (id: string | undefined) => ({
    data: id ? projectsState.data?.rows.find((p) => p.id === id) : undefined,
  }),
}));

// ─── component under test ─────────────────────────────────────────────────────

import { ProjectsScreen } from './ProjectsScreen';
import { usePreferencesStore } from '@/state/stores/usePreferencesStore';

// ─── helpers ──────────────────────────────────────────────────────────────────

function makeProject(id: string, name: string): ProjectRow {
  return { id, name, lineCount: 0, status: 'ACTIVE' };
}

afterEach(cleanup);

beforeEach(() => {
  projectsState = { isLoading: true, isError: false };
  projectCountState = undefined;
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
