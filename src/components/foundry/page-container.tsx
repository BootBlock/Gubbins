import { type ReactNode } from 'react';
import { cn } from '@/lib/utils';

export interface PageContainerProps {
  readonly children: ReactNode;
  /**
   * Full-height variant for master-detail screens (Inventory, Projects) that own an
   * internal scroll region: pins the page to the viewport height (`h-dvh`) instead of
   * growing with content, and drops the inter-section gap so the screen controls its
   * own internal spacing. The header still lands at the identical top-left as every
   * other screen.
   */
  readonly fullHeight?: boolean;
  /** Extra classes merged onto the frame (e.g. `relative isolate` for a backdrop). */
  readonly className?: string;
}

/**
 * Foundry PageContainer — the one canonical page frame (spec §2.4.2).
 *
 * Centres every screen at a single fixed width with one shared horizontal padding and
 * top offset, so the brand mark, {@link PageHeader} and everything below always begin at
 * the exact same X/Y coordinate regardless of the screen's content. Screens used to each
 * pick their own `max-w-*` (3xl … 7xl) and top padding, so the whole frame — and the
 * header with it — jumped around as you navigated. The `max-w-6xl` width matches the root
 * chrome's storage-banner container, so the page aligns with the app shell too.
 */
export function PageContainer({ children, fullHeight, className }: PageContainerProps) {
  return (
    <div
      className={cn(
        'mx-auto flex w-full max-w-6xl flex-col px-4 pt-6',
        fullHeight ? 'h-dvh pb-6' : 'min-h-dvh gap-6 pb-16',
        className,
      )}
    >
      {children}
    </div>
  );
}
