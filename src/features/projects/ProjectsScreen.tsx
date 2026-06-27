import { useEffect, useState } from 'react';
import { Link } from '@tanstack/react-router';
import { Button, Spinner, Surface } from '@/components/foundry';
import { AddIcon, BrandIcon, PackageIcon, ProjectIcon } from '@/components/icons';
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

  // Default the selection to the first project once loaded.
  useEffect(() => {
    if (selectedId === null && rows.length > 0) setSelectedId(rows[0]!.id);
  }, [rows, selectedId]);

  return (
    <div className="mx-auto flex h-dvh w-full max-w-7xl flex-col px-4 pb-4 pt-4">
      <header className="flex flex-wrap items-center gap-3 pb-4">
        <Link to="/" className="flex items-center gap-2 text-foreground [&_svg]:size-6">
          <span className="grid size-9 place-items-center rounded-xl bg-primary/15 text-primary [&_svg]:size-5">
            <BrandIcon />
          </span>
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
        <main className="flex min-w-0 flex-1 flex-col">
          {selectedId ? (
            <ProjectDetail projectId={selectedId} />
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
