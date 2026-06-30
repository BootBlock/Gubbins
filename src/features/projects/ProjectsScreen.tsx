import { useEffect, useState } from 'react';
import { Link } from '@tanstack/react-router';
import { Button, Spinner, Surface, MAIN_CONTENT_ID } from '@/components/foundry';
import { AddIcon, PackageIcon, ProjectIcon } from '@/components/icons';
import { BrandMark } from '@/components/BrandMark';
import { cn } from '@/lib/utils';
import { useProjects } from './projects';
import { PROJECT_STATUS_LABELS } from './components/projects-ui';
import { CreateProjectDialog } from './components/CreateProjectDialog';
import { ProjectDetail } from './components/ProjectDetail';

/**
 * The Phase 4 projects workspace (spec §5): a master list of projects on the left
 * and the selected project's BOM, costing, procurement and shopping list on the right.
 */
export function ProjectsScreen() {
  const projects = useProjects();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);

  const rows = projects.data?.rows ?? [];

  // Default the selection to the first project once loaded. Only acts when nothing is
  // selected, so it never fights an explicit selection (e.g. a freshly created project
  // selected via onCreated before the list cache has refetched).
  useEffect(() => {
    if (selectedId === null && rows.length > 0) setSelectedId(rows[0]!.id);
  }, [rows, selectedId]);

  // On delete, jump to the next surviving project deterministically (computed from the
  // current list minus the removed one) rather than clearing to null and re-deriving
  // from a stale cache — which could briefly re-select the just-deleted project.
  const selectAfterDelete = (deletedId: string) => {
    const next = rows.find((p) => p.id !== deletedId);
    setSelectedId(next?.id ?? null);
  };

  return (
    <div className="mx-auto flex h-dvh w-full max-w-7xl flex-col px-4 pb-4 pt-4">
      <header className="flex flex-wrap items-center gap-3 pb-4">
        <Link to="/" className="flex items-center gap-2 text-foreground [&_svg]:size-6">
          <BrandMark className="size-9 rounded-xl" />
          <span className="text-lg font-semibold tracking-tight">Gubbins</span>
        </Link>

        <Link
          to="/inventory"
          className="ml-auto inline-flex items-center gap-2 rounded-lg px-3 py-2 text-sm text-muted-foreground transition-colors hover:bg-secondary/60 hover:text-foreground [&_svg]:size-4"
        >
          <PackageIcon />
          Inventory
        </Link>

        <Button onClick={() => setCreateOpen(true)}>
          <AddIcon />
          New project
        </Button>
      </header>

      <div className="flex min-h-0 flex-1 gap-6">
        {/* Master list */}
        <aside className="w-64 shrink-0 overflow-y-auto">
          {projects.isLoading ? (
            <div className="flex justify-center pt-8">
              <Spinner />
            </div>
          ) : rows.length === 0 ? (
            <p className="px-2 pt-6 text-sm text-muted-foreground">
              No projects yet. Create one to plan a build.
            </p>
          ) : (
            <ul className="space-y-1">
              {rows.map((project) => (
                <li key={project.id}>
                  <button
                    type="button"
                    onClick={() => setSelectedId(project.id)}
                    className={cn(
                      'flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-left text-sm transition-colors [&_svg]:size-4',
                      project.id === selectedId
                        ? 'bg-primary/15 text-primary'
                        : 'text-muted-foreground hover:bg-secondary/60 hover:text-foreground',
                    )}
                  >
                    <ProjectIcon />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-medium">{project.name}</span>
                      <span className="block text-xs opacity-70">
                        {project.lineCount} part{project.lineCount === 1 ? '' : 's'} ·{' '}
                        {PROJECT_STATUS_LABELS[project.status]}
                      </span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </aside>

        {/* Detail */}
        <main
          id={MAIN_CONTENT_ID}
          tabIndex={-1}
          className="flex min-w-0 flex-1 animate-rise flex-col outline-none"
        >
          {/*
           * WCAG 4.1.3 — always-mounted polite status region. The master list lives in
           * the <aside> so the result count would otherwise change silently as projects
           * are created or deleted. This region is inside <main> to match the Phase-40
           * Inventory pattern and must be mounted before data loads so later text
           * mutations are announced by screen readers.
           */}
          <p
            className="sr-only"
            role="status"
            aria-live="polite"
            data-testid="projects-count-live"
          >
            {projects.isLoading
              ? 'Loading projects…'
              : rows.length === 0
                ? 'No projects yet.'
                : `${rows.length} project${rows.length === 1 ? '' : 's'}.`}
          </p>
          {selectedId ? (
            // Keyed by project id so picking a different project replays the swap-in
            // entrance as the detail pane is replaced (reduced-motion handled globally).
            <div key={selectedId} className="flex min-h-0 flex-1 animate-swap-in flex-col">
              <ProjectDetail projectId={selectedId} onDeleted={() => selectAfterDelete(selectedId)} />
            </div>
          ) : (
            <Surface className="grid flex-1 place-items-center p-8 text-center">
              <div className="text-muted-foreground">
                <ProjectIcon className="mx-auto mb-3 size-8 opacity-50" />
                <p className="text-sm">Select a project, or create a new one.</p>
              </div>
            </Surface>
          )}
        </main>
      </div>

      <CreateProjectDialog
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        onCreated={(id) => setSelectedId(id)}
      />
    </div>
  );
}
