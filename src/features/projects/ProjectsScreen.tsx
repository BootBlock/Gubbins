import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import {
  Button,
  Drawer,
  Glyph,
  PageContainer,
  PageHeader,
  Pagination,
  Spinner,
  Surface,
  pageCount,
  useCompactLayout,
  MAIN_CONTENT_ID,
} from '@/components/foundry';
import { AddIcon, ImportIcon, ProjectIcon } from '@/components/icons';
import { useT } from '@/features/i18n';
import { useHotkeyScope } from '@/features/hotkeys/useHotkeyScope';
import { useHotkeyIntent } from '@/features/hotkeys/useHotkeyIntent';
import { PAGE_SIZE_BOUNDS, PAGE_SIZE_PRESETS } from '@/features/settings/settings';
import { usePreferencesStore } from '@/state/stores/usePreferencesStore';
import { plural } from '@/lib/plural';
import { cn } from '@/lib/utils';
import { useProject, useProjectCount, useProjects } from './projects';
import { PROJECT_STATUS_LABELS } from './components/projects-ui';
import { CreateProjectDialog } from './components/CreateProjectDialog';
import { ImportBomDialog } from './components/ImportBomDialog';
import { ProjectDetail } from './components/ProjectDetail';

/**
 * The Phase 4 projects workspace (spec §5): a master list of projects on the left
 * and the selected project's BOM, costing, procurement and shopping list on the right.
 *
 * The master list pages **server-side** (issue #149): a single capped read left every project
 * past the hundredth unreachable and said nothing, on the only screen that can open one. With
 * pagination switched off it still reads one bounded page, and says how many that leaves out.
 */
export function ProjectsScreen() {
  const t = useT();
  const paginated = usePreferencesStore((s) => s.paginateLists);
  const defaultPageSize = usePreferencesStore((s) => s.defaultPageSize);
  const setDefaultPageSize = usePreferencesStore((s) => s.setDefaultPageSize);
  const [page, setPage] = useState(1);
  // Unpaginated, the list still reads a bounded page — the ceiling is the repository's, and
  // asking for more than it allows would silently clamp anyway.
  const pageSize = paginated ? defaultPageSize : PAGE_SIZE_BOUNDS.max;

  const projects = useProjects(page, pageSize);
  const total = useProjectCount();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selectedProject = useProject(selectedId ?? undefined);
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
  // Fall back to the rows in hand when the count is unavailable, so a failed count query
  // degrades to "one page" rather than silently removing the pager from a longer list.
  const totalProjects = total.data ?? (projects.data ? projects.data.offset + rows.length : 0);
  const pages = pageCount(totalProjects, pageSize);
  // Unpaginated the read is capped at one page; how many projects that leaves unreachable.
  const hiddenProjects = paginated ? 0 : Math.max(0, totalProjects - rows.length);

  // Deleting the last project on the final page leaves the page out of range.
  useEffect(() => {
    if (paginated && pages > 0 && page > pages) setPage(pages);
  }, [paginated, pages, page]);

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
      <>
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
        {paginated ? (
          <Pagination
            className="mt-3"
            page={page}
            pageCount={pages}
            onPageChange={setPage}
            pageSize={defaultPageSize}
            onPageSizeChange={setDefaultPageSize}
            pageSizeOptions={PAGE_SIZE_PRESETS}
            minPageSize={PAGE_SIZE_BOUNDS.min}
            maxPageSize={PAGE_SIZE_BOUNDS.max}
            totalItems={totalProjects}
            data-testid="projects-pagination"
          />
        ) : hiddenProjects > 0 ? (
          // Unpaginated the read is still bounded, so say so rather than quietly hiding
          // projects on the only screen that can open one.
          <p className="px-2 pt-3 text-xs text-muted-foreground" data-testid="projects-truncated">
            {t('projects.list.truncated', { vars: { count: hiddenProjects, shown: rows.length } })}
          </p>
        ) : null}
      </>
    );

  // Named from the project itself rather than from the rows in view: once the list pages, the
  // selection can sit on a page you have navigated away from, and the compact trigger would
  // otherwise read "No project selected" beside the very project it opens. `ProjectDetail`
  // already holds this query, so this is a cache read rather than a second round trip.
  const selectedProjectLabel = selectedProject.data?.name ?? t('projects.list.none');

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
                : totalProjects === 0
                  ? 'No projects yet.'
                  : // The whole set, not the page in view — the count is what the user is
                    // being told they have, and a per-page figure would understate it.
                    `${totalProjects} ${plural(totalProjects, 'project')}.`}
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
