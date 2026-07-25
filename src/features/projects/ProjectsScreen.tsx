import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import {
  Button,
  Drawer,
  Glyph,
  PageContainer,
  PageHeader,
  Spinner,
  Surface,
  useCompactLayout,
  MAIN_CONTENT_ID,
} from '@/components/foundry';
import { AddIcon, ImportIcon, ProjectIcon } from '@/components/icons';
import { useT } from '@/features/i18n';
import { useHotkeyScope } from '@/features/hotkeys/useHotkeyScope';
import { useHotkeyIntent } from '@/features/hotkeys/useHotkeyIntent';
import { plural } from '@/lib/plural';
import { cn } from '@/lib/utils';
import { useProjects } from './projects';
import { PROJECT_STATUS_LABELS } from './components/projects-ui';
import { CreateProjectDialog } from './components/CreateProjectDialog';
import { ImportBomDialog } from './components/ImportBomDialog';
import { ProjectDetail } from './components/ProjectDetail';

/**
 * The Phase 4 projects workspace (spec §5): a master list of projects on the left
 * and the selected project's BOM, costing, procurement and shopping list on the right.
 */
export function ProjectsScreen() {
  const t = useT();
  const projects = useProjects();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  // Compact viewport (issue #147): the fixed 256px master list would take most of a phone's
  // width, so below the tablet floor it moves into an off-canvas drawer reached from a trigger
  // above the detail pane. See `useCompactLayout` for why this is a hook and not a CSS variant.
  const compact = useCompactLayout();
  const [listDrawerOpen, setListDrawerOpen] = useState(false);
  // Widening back past the breakpoint puts the list back on screen; leaving the drawer flagged
  // open would spring it over the content the next time the viewport narrows.
  useEffect(() => {
    if (!compact) setListDrawerOpen(false);
  }, [compact]);

  const rows = useMemo(() => projects.data?.rows ?? [], [projects.data?.rows]);

  // The contextual "new" shortcut (issue #127): on this screen, `N` creates a project.
  useHotkeyScope({ onNew: useCallback(() => setCreateOpen(true), []) });

  // A "new project" shortcut pressed from another screen navigates here and leaves an intent
  // behind, since the create dialog is local state with no route of its own.
  const pendingIntent = useHotkeyIntent((s) => s.pending);
  useEffect(() => {
    if (pendingIntent !== 'new-project') return;
    useHotkeyIntent.getState().consume('new-project');
    setCreateOpen(true);
  }, [pendingIntent]);

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

  /**
   * The master list itself, rendered identically whether it sits in the `<aside>` beside the
   * detail pane or inside the compact drawer — one definition, so the two placements can never
   * drift. `onPick` is where they differ: in the drawer, choosing a project also closes it.
   */
  const masterList = (onPick: (id: string) => void): ReactNode =>
    projects.isLoading ? (
      <div className="flex justify-center pt-8">
        <Spinner />
      </div>
    ) : projects.isError ? (
      // Never fall through to the empty state on failure: "No projects yet" would read
      // like success and hide a real error behind cheerful copy (issue #306).
      <Surface className="flex flex-col items-center gap-3 p-6 text-center">
        <p role="alert" className="text-sm text-destructive">
          {t('projects.list.error')}
        </p>
        <Button variant="outline" onClick={() => void projects.refetch()}>
          {t('projects.list.retry')}
        </Button>
      </Surface>
    ) : rows.length === 0 ? (
      <p className="px-2 pt-6 text-sm text-muted-foreground">No projects yet. Create one to plan a build.</p>
    ) : (
      <ul className="space-y-1">
        {rows.map((project) => (
          <li key={project.id}>
            <button
              type="button"
              onClick={() => onPick(project.id)}
              className={cn(
                'flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-left text-sm transition-colors [&_svg]:size-4',
                project.id === selectedId
                  ? 'bg-primary/15 text-primary'
                  : 'text-muted-foreground hover:bg-secondary/60 hover:text-foreground',
              )}
            >
              <Glyph name={project.icon} fallback={ProjectIcon} />
              <span className="min-w-0 flex-1">
                <span className="block truncate font-medium">{project.name}</span>
                <span className="block text-xs opacity-70">
                  {project.lineCount} {plural(project.lineCount, 'part')} ·{' '}
                  {PROJECT_STATUS_LABELS[project.status]}
                </span>
              </span>
            </button>
          </li>
        ))}
      </ul>
    );

  const selectedProjectLabel = rows.find((p) => p.id === selectedId)?.name ?? t('projects.list.none');

  return (
    <PageContainer fullHeight>
      <PageHeader
        className="pb-4"
        icon={<ProjectIcon />}
        title="Projects"
        actions={
          <>
            <Button variant="outline" onClick={() => setImportOpen(true)}>
              <ImportIcon />
              Import BOM
            </Button>
            <Button onClick={() => setCreateOpen(true)}>
              <AddIcon />
              New project
            </Button>
          </>
        }
      />

      {/* Wide: master list beside the detail. Compact: the list is in the drawer below, and the
          row stacks so its trigger sits directly above the project it opens. */}
      <div className={cn('flex min-h-0 flex-1', compact ? 'flex-col gap-3' : 'gap-6')}>
        {compact ? (
          projects.isError ? (
            /* A list that failed to load has nothing to browse, so the error goes where the
               trigger would be rather than behind a drawer no one has a reason to open. Burying
               it would leave the phone reading like an empty inventory — the exact failure mode
               issue #306 fixed on the wide layout. */
            masterList(setSelectedId)
          ) : (
            <Button
              variant="outline"
              className="w-full justify-start"
              onClick={() => setListDrawerOpen(true)}
              aria-haspopup="dialog"
              aria-expanded={listDrawerOpen}
              aria-label={t('projects.list.drawer.trigger', {
                vars: { project: selectedProjectLabel },
              })}
              data-testid="open-projects-drawer"
            >
              <ProjectIcon />
              {t('projects.list.title')}
              {/* Which project the detail pane is showing, so the trigger doubles as the
                  breadcrumb the master list would otherwise give you at a glance. */}
              <span aria-hidden className="min-w-0 truncate font-normal text-muted-foreground">
                {selectedProjectLabel}
              </span>
            </Button>
          )
        ) : (
          /* Master list. Labelled because it carries no visible heading of its own — in the
             drawer that job falls to the panel's `<h2>`. */
          <aside aria-label={t('projects.list.title')} className="w-64 shrink-0 overflow-y-auto">
            {masterList(setSelectedId)}
          </aside>
        )}

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
          <p className="sr-only" role="status" aria-live="polite" data-testid="projects-count-live">
            {projects.isLoading
              ? 'Loading projects…'
              : projects.isError
                ? // The visible error carries its own role="alert"; keep this polite region
                  // from also (mis)reporting an empty list on failure (issue #306).
                  ''
                : rows.length === 0
                  ? 'No projects yet.'
                  : `${rows.length} ${plural(rows.length, 'project')}.`}
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

      {/* The compact home of the master list. Picking a project is the drawer's whole purpose,
          so it closes on choice and hands the screen back to the detail pane. */}
      {compact && listDrawerOpen ? (
        <Drawer open onClose={() => setListDrawerOpen(false)} title={t('projects.list.title')}>
          {masterList((id) => {
            setSelectedId(id);
            setListDrawerOpen(false);
          })}
        </Drawer>
      ) : null}

      <CreateProjectDialog
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        onCreated={(id) => setSelectedId(id)}
      />

      <ImportBomDialog
        open={importOpen}
        onClose={() => setImportOpen(false)}
        onCreated={(id) => setSelectedId(id)}
      />
    </PageContainer>
  );
}
