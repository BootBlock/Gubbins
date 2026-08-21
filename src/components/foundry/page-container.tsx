import { type ReactNode } from 'react';
import { cn } from '@/lib/utils';
import { usePreferencesStore } from '@/state/stores/usePreferencesStore';

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
 *
 * Both offsets come from the `safe-*` spacing tokens, so on a device that reserves screen
 * edges — a notch, a punch-hole, rounded corners, the gesture home bar — the frame begins
 * clear of them rather than under them (issue #655). The horizontal pair is deliberately
 * symmetric, so the centred column stays centred when only one side carries a cutout.
 *
 * On a **large-format** touch device (tablet / unfolded foldable) the `max-w-6xl` cap is
 * relaxed to a wider ceiling (and the side gutter widened), so the frame reclaims the room
 * it would otherwise leave as empty margin — see the `large-format:` variant in
 * `styles/index.css` and `lib/env/device.ts`. Standard phones and laptops are untouched.
 *
 * When the user turns on **Full width** (Settings → Appearance, issue #14) the centred `max-w`
 * cap is dropped entirely — including the large-format ceiling — so every screen fills the
 * viewport width; the horizontal padding is kept so content never touches the edge. Off by
 * default (the centred column is the shipped look), read straight from the preferences store.
 */
export function PageContainer({ children, fullHeight, className }: PageContainerProps) {
  const fullWidth = usePreferencesStore((s) => s.fullWidth);
  return (
    <div
      className={cn(
        'mx-auto flex w-full flex-col px-safe-gutter-x pt-safe-page-top large-format:px-safe-gutter-x-lg',
        fullWidth ? 'max-w-none' : 'max-w-6xl large-format:max-w-[90rem]',
        fullHeight ? 'h-dvh pb-safe-page-bottom' : 'min-h-dvh gap-6 pb-16',
        className,
      )}
    >
      {children}
    </div>
  );
}
