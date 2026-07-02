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
import { render, screen, cleanup } from '@testing-library/react';

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
vi.mock('./components/ProjectDetail', () => ({
  ProjectDetail: () => <div data-testid="project-detail" />,
}));

// ─── controlled query stub ────────────────────────────────────────────────────

type ProjectRow = { id: string; name: string; lineCount: number; status: string };

let projectsState: { isLoading: boolean; data?: { rows: ProjectRow[] } } = {
  isLoading: true,
};

vi.mock('./projects', () => ({
  useProjects: () => projectsState,
}));

// ─── component under test ─────────────────────────────────────────────────────

import { ProjectsScreen } from './ProjectsScreen';

// ─── helpers ──────────────────────────────────────────────────────────────────

function makeProject(id: string, name: string): ProjectRow {
  return { id, name, lineCount: 0, status: 'ACTIVE' };
}

afterEach(cleanup);

beforeEach(() => {
  projectsState = { isLoading: true };
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
