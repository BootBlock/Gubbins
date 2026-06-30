import { type ReactNode } from 'react';
import { PageContainer, PageHeader, Surface, buttonVariants, MAIN_CONTENT_ID } from '@/components/foundry';
import {
  InfoIcon,
  LinkIcon,
  AlertIcon,
  SecureIcon,
  ContactsIcon,
} from '@/components/icons';
import { cn } from '@/lib/utils';
import { APP_VERSION } from '@/lib/app-version';
import { Starfield } from './Starfield';

/** Project links — single source so the screen and any future surfaces agree. */
const REPO_URL = 'https://github.com/BootBlock/Gubbins';
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
  return (
    <PageContainer className="relative isolate">
      <Starfield />
      <PageHeader icon={<InfoIcon />} title="About" />

      <main
        id={MAIN_CONTENT_ID}
        tabIndex={-1}
        className="flex flex-1 animate-rise flex-col gap-6 outline-none"
      >
        <AboutSection icon={<InfoIcon />} title="About Gubbins">
          <p className="text-sm text-muted-foreground">
            Gubbins is a local-first, offline-capable app for tracking{' '}
            <span className="text-foreground">anything you own</span> — electronics, 3D-printing
            supplies, tools, collections, and general inventory. Everything is stored privately on
            this device; nothing is sent to a server.
          </p>
          <dl className="mt-4 flex items-center gap-2 text-sm">
            <dt className="text-muted-foreground">Version</dt>
            <dd className="font-medium tabular-nums" data-testid="about-version">
              {APP_VERSION}
            </dd>
          </dl>
        </AboutSection>

        <AboutSection icon={<LinkIcon />} title="Project &amp; support">
          <p className="text-sm text-muted-foreground">
            Source code, issue tracking and releases live on GitHub. Found a bug or have an idea?
            Please open an issue.
          </p>
          <div className="mt-4 flex flex-wrap gap-2">
            <ExternalLink href={REPO_URL}>
              <LinkIcon />
              GitHub repository
            </ExternalLink>
            <ExternalLink href={ISSUES_URL}>
              <AlertIcon />
              Report an issue
            </ExternalLink>
          </div>
        </AboutSection>

        <AboutSection icon={<ContactsIcon />} title="Author">
          <p className="text-sm text-muted-foreground">
            Created by{' '}
            <ExternalLink href={AUTHOR_URL} inline>
              Joe Cox
            </ExternalLink>
            .
          </p>
          <div className="mt-4 flex flex-wrap gap-2">
            <ExternalLink href={WEBSITE_URL}>
              <LinkIcon />
              Personal website
            </ExternalLink>
            <ExternalLink href={AUTHOR_URL}>
              <ContactsIcon />
              GitHub profile
            </ExternalLink>
          </div>
        </AboutSection>

        <AboutSection icon={<SecureIcon />} title="Privacy">
          <p className="text-sm text-muted-foreground">
            Local-first by design: all data is processed and stored entirely within your browser on
            this device. There is no account and no server-side data collection. Use the same
            browser profile to find your data again, and install the app or sync to a folder you
            control to keep a backup.
          </p>
        </AboutSection>

        <AboutSection icon={<InfoIcon />} title="AI-assisted development">
          <p className="text-sm text-muted-foreground">
            AI tooling was used in the development of this software.
          </p>
        </AboutSection>

        <AboutSection icon={<SecureIcon />} title="Licence &amp; disclaimer">
          <p className="text-sm text-muted-foreground">
            Released under the{' '}
            <ExternalLink href={LICENCE_URL} inline>
              MIT Licence
            </ExternalLink>
            .
          </p>
          <p className="mt-2 text-xs text-muted-foreground">
            This software is provided “as is”, without warranty of any kind. You use it{' '}
            <span className="text-foreground">entirely at your own risk</span>; the developers accept
            no responsibility or liability for any loss, damage, data loss, or other issues arising
            from its use.
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
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className={cn(buttonVariants({ variant: 'outline' }))}
    >
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
    <Surface className="p-5">
      <div className="flex items-center gap-2.5 text-muted-foreground [&_svg]:size-4">
        {icon}
        <h2 className="text-sm font-semibold text-foreground">{title}</h2>
      </div>
      <div className="mt-4">{children}</div>
    </Surface>
  );
}
