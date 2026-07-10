import { type ReactNode } from 'react';
import { PageContainer, PageHeader, Surface, buttonVariants, MAIN_CONTENT_ID } from '@/components/foundry';
import { InfoIcon, LinkIcon, AlertIcon, SecureIcon, ContactsIcon, WikiIcon } from '@/components/icons';
import { cn } from '@/lib/utils';
import { APP_VERSION, APP_RELEASE_DATE } from '@/lib/app-version';
import { useT } from '@/features/i18n';
import { Starfield } from './Starfield';

/**
 * Build date formatted once for display — mirrors the dashboard hero's version chip
 * (`DashboardVersion`) so the two surfaces render the same date the same way.
 */
const BUILD_DATE_LABEL = new Intl.DateTimeFormat(undefined, {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
}).format(new Date(`${APP_RELEASE_DATE}T00:00:00`));

/** Project links — single source so the screen and any future surfaces agree. */
const REPO_URL = 'https://github.com/BootBlock/Gubbins';
const WIKI_URL = 'https://github.com/BootBlock/Gubbins/wiki';
const ISSUES_URL = 'https://github.com/BootBlock/Gubbins/issues';
const LICENCE_URL = 'https://github.com/BootBlock/Gubbins/blob/main/LICENSE';
const AUTHOR_URL = 'https://github.com/BootBlock';
const WEBSITE_URL = 'https://bootblock.co.uk';

/**
 * About screen (§3) — application details, project/support links, author,
 * privacy posture, AI-development note, licence and disclaimer. A read-only
 * informational surface; it mirrors the Settings screen's header + `Surface`
 * section layout so it sits naturally in the app chrome.
 */
export function AboutScreen() {
  const t = useT();
  return (
    <PageContainer className="relative isolate">
      <Starfield />
      <PageHeader icon={<InfoIcon />} title={t('about.title')} />

      <main
        id={MAIN_CONTENT_ID}
        tabIndex={-1}
        className="flex flex-1 animate-rise flex-col gap-6 outline-none"
      >
        <AboutSection icon={<InfoIcon />} title={t('about.app.title')}>
          <p className="text-sm text-muted-foreground">
            {t('about.app.intro.pre')}{' '}
            <span className="text-foreground">{t('about.app.intro.emphasis')}</span>{' '}
            {t('about.app.intro.post')}
          </p>
          <dl className="mt-4 space-y-2 text-sm">
            <div className="flex items-center gap-2">
              <dt className="text-muted-foreground">{t('about.app.version')}</dt>
              <dd className="font-medium tabular-nums" data-testid="about-version">
                {APP_VERSION}
              </dd>
            </div>
            <div className="flex items-center gap-2">
              <dt className="text-muted-foreground">{t('about.app.buildDate')}</dt>
              <dd className="font-medium tabular-nums" data-testid="about-build-date">
                {BUILD_DATE_LABEL}
              </dd>
            </div>
          </dl>
        </AboutSection>

        <AboutSection icon={<LinkIcon />} title={t('about.project.title')}>
          <p className="text-sm text-muted-foreground">{t('about.project.body')}</p>
          <div className="mt-4 flex flex-wrap gap-2">
            <ExternalLink href={WIKI_URL}>
              <WikiIcon />
              {t('about.project.wiki')}
            </ExternalLink>
            <ExternalLink href={REPO_URL}>
              <LinkIcon />
              {t('about.project.repo')}
            </ExternalLink>
            <ExternalLink href={ISSUES_URL}>
              <AlertIcon />
              {t('about.project.issue')}
            </ExternalLink>
          </div>
        </AboutSection>

        <AboutSection icon={<ContactsIcon />} title={t('about.author.title')}>
          <p className="text-sm text-muted-foreground">
            {t('about.author.createdBy')}{' '}
            <ExternalLink href={AUTHOR_URL} inline>
              Joe Cox
            </ExternalLink>
            .
          </p>
          <div className="mt-4 flex flex-wrap gap-2">
            <ExternalLink href={WEBSITE_URL}>
              <LinkIcon />
              {t('about.author.website')}
            </ExternalLink>
            <ExternalLink href={AUTHOR_URL}>
              <ContactsIcon />
              {t('about.author.profile')}
            </ExternalLink>
          </div>
        </AboutSection>

        <AboutSection icon={<SecureIcon />} title={t('about.privacy.title')}>
          <p className="text-sm text-muted-foreground">{t('about.privacy.body')}</p>
        </AboutSection>

        <AboutSection icon={<InfoIcon />} title={t('about.ai.title')}>
          <p className="text-sm text-muted-foreground">{t('about.ai.body')}</p>
        </AboutSection>

        <AboutSection icon={<SecureIcon />} title={t('about.licence.title')}>
          <p className="text-sm text-muted-foreground">
            {t('about.licence.body.pre')}{' '}
            <ExternalLink href={LICENCE_URL} inline>
              {t('about.licence.body.link')}
            </ExternalLink>
            .
          </p>
          <p className="mt-2 text-xs text-muted-foreground">
            {t('about.licence.disclaimer.pre')}{' '}
            <span className="text-foreground">{t('about.licence.disclaimer.emphasis')}</span>
            {t('about.licence.disclaimer.post')}
          </p>
        </AboutSection>
      </main>
    </PageContainer>
  );
}

/** An anchor to an external resource — opens in a new tab, styled as a button or inline link. */
function ExternalLink({
  href,
  inline,
  children,
}: {
  readonly href: string;
  readonly inline?: boolean;
  readonly children: ReactNode;
}) {
  if (inline) {
    return (
      <a
        href={href}
        target="_blank"
        rel="noreferrer"
        className="font-medium text-primary underline-offset-4 hover:underline"
      >
        {children}
      </a>
    );
  }
  return (
    <a href={href} target="_blank" rel="noreferrer" className={cn(buttonVariants({ variant: 'outline' }))}>
      {children}
    </a>
  );
}

function AboutSection({
  icon,
  title,
  children,
}: {
  readonly icon: ReactNode;
  readonly title: string;
  readonly children: ReactNode;
}) {
  return (
    // These cards float over the decorative starfield, so they use a far more
    // translucent fill (`bg-card/20`) than Surface's default glass and disable the
    // `backdrop-blur`. The blur is dropped deliberately: the enclosing `<main>` runs
    // the `animate-rise` entrance (an opacity + transform animation), and while that
    // group is compositing the children's `backdrop-filter` is suppressed by the
    // browser, then snaps in the instant the animation ends — smearing the small stars
    // into near-invisibility with a visible ~1s "pop". Without the filter the final
    // look is present from the first paint, and the sharp stars stay visible through
    // the tint, which is the point of the starfield.
    <Surface className="bg-card/60 p-5 backdrop-blur-none">
      <div className="flex items-center gap-2.5 text-muted-foreground [&_svg]:size-4">
        {icon}
        <h2 className="text-sm font-semibold text-foreground">{title}</h2>
      </div>
      <div className="mt-4">{children}</div>
    </Surface>
  );
}
