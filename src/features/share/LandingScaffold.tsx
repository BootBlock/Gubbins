import { type ReactNode } from 'react';
import { PageContainer, PageHeader, MAIN_CONTENT_ID, Spinner } from '@/components/foundry';

/**
 * The shared frame for the inbound landing routes (share target, file handler, deep link — plan
 * EI-4). Each is a brief "opening…" screen that immediately hands off to an existing dialog, so
 * they share one header + `<main id="main-content">` + skip-link-target + spinner shell and differ
 * only in icon, title, and status message. The routed dialog is passed as `children`.
 */
export function LandingScaffold({
  icon,
  title,
  message,
  children,
}: {
  icon: ReactNode;
  title: string;
  message: string;
  children?: ReactNode;
}) {
  return (
    <PageContainer>
      <PageHeader icon={icon} title={title} />
      <main
        id={MAIN_CONTENT_ID}
        tabIndex={-1}
        className="flex flex-1 flex-col items-center justify-center gap-3 py-16 text-center outline-none"
      >
        <Spinner />
        <p className="text-sm text-muted-foreground">{message}</p>
      </main>
      {children}
    </PageContainer>
  );
}
