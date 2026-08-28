import { Button, Surface } from '@/components/foundry';
import {
  AddIcon,
  AssemblyIcon,
  BudgetIcon,
  ImportIcon,
  ProjectIcon,
  ReserveIcon,
  ShoppingCartIcon,
  type LucideIcon,
} from '@/components/icons';
import { useT, type MessageKey } from '@/features/i18n';

/** The wiki page this screen's explainer points at for the full tour of the feature. */
const PROJECTS_WIKI_URL = 'https://github.com/BootBlock/Gubbins/wiki/Projects-and-BOM';

/**
 * What a project *does*, one capability per row. Held as a list rather than five hand-written
 * blocks so each row's icon and copy stay together and the layout is written once. The keys are
 * spelled out in full rather than derived from a stem, so the typed catalog still checks them.
 */
const CAPABILITIES = [
  { icon: ProjectIcon, title: 'projects.intro.bom.title', body: 'projects.intro.bom.body' },
  {
    icon: ShoppingCartIcon,
    title: 'projects.intro.shopping.title',
    body: 'projects.intro.shopping.body',
  },
  {
    icon: ReserveIcon,
    title: 'projects.intro.reserve.title',
    body: 'projects.intro.reserve.body',
  },
  { icon: BudgetIcon, title: 'projects.intro.budget.title', body: 'projects.intro.budget.body' },
  { icon: AssemblyIcon, title: 'projects.intro.build.title', body: 'projects.intro.build.body' },
] as const satisfies readonly { icon: LucideIcon; title: MessageKey; body: MessageKey }[];

export interface ProjectsIntroProps {
  /** Open the create-project dialog — the primary way out of the empty state. */
  readonly onCreate: () => void;
  /** Open the BOM import dialog, for a build whose parts list already exists elsewhere. */
  readonly onImport: () => void;
}

/**
 * The first-run explainer shown in the detail pane when there are no projects at all
 * (issue #421). "Select a project, or create a new one" is a fair prompt once projects exist
 * and none is selected, but it is the wrong sentence for someone who has never used the
 * feature: it names an action without saying what a project *is*, or why they would want one,
 * on the one screen where they have nothing else to look at.
 *
 * Deliberately shown only for a genuinely empty list — a filter that emptied it gets the master
 * list's "clear filters" route instead, and a failed load gets the error.
 */
export function ProjectsIntro({ onCreate, onImport }: ProjectsIntroProps) {
  const t = useT();
  return (
    <Surface className="flex min-h-0 flex-1 flex-col overflow-y-auto p-6 sm:p-8" data-testid="projects-intro">
      <div className="mx-auto flex w-full max-w-2xl flex-col gap-6">
        <div className="flex flex-col items-center gap-3 text-center">
          <ProjectIcon aria-hidden className="size-8 text-primary" />
          <h2 className="text-lg font-semibold">{t('projects.intro.heading')}</h2>
          <p className="text-sm text-muted-foreground">{t('projects.intro.lead')}</p>
        </div>

        <ul className="flex flex-col gap-4">
          {CAPABILITIES.map(({ icon: Icon, title, body }) => (
            <li key={title} className="flex items-start gap-3">
              <Icon aria-hidden className="mt-0.5 size-4 shrink-0 text-primary" />
              <div className="min-w-0">
                <p className="text-sm font-medium">{t(title)}</p>
                <p className="text-sm text-muted-foreground">{t(body)}</p>
              </div>
            </li>
          ))}
        </ul>

        <p className="text-sm text-muted-foreground">{t('projects.intro.start')}</p>

        <div className="flex flex-wrap items-center justify-center gap-3">
          <Button onClick={onCreate} data-testid="projects-intro-create">
            <AddIcon />
            {t('projects.intro.create')}
          </Button>
          <Button variant="outline" onClick={onImport} data-testid="projects-intro-import">
            <ImportIcon />
            {t('projects.intro.import')}
          </Button>
        </div>

        <p className="text-center text-xs text-muted-foreground">
          <a
            href={PROJECTS_WIKI_URL}
            target="_blank"
            rel="noreferrer"
            className="font-medium text-primary underline-offset-4 hover:underline"
          >
            {t('projects.intro.wiki')}
          </a>
        </p>
      </div>
    </Surface>
  );
}
