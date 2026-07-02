import { type ReactNode } from 'react';
import { Link } from '@tanstack/react-router';
import { BrandMark } from '@/components/BrandMark';
import { AppNav } from '@/components/nav/AppNav';
import { HeaderSearch } from '@/features/command-palette/HeaderSearch';
import { cn } from '@/lib/utils';

export interface PageHeaderProps {
  /** The screen's glyph, rendered before the title (sized to 1.25rem via the `<h1>`). */
  readonly icon: ReactNode;
  /** The page title — rendered as the screen's single `<h1>`. */
  readonly title: ReactNode;
  /**
   * Page-specific controls (buttons, an overflow menu, search …). Rendered just before
   * the always-present global {@link AppNav} menu in the right-aligned action row. Cross-
   * screen navigation does **not** belong here — that lives in AppNav now. Omit for a
   * header with no page actions of its own.
   */
  readonly actions?: ReactNode;
  /**
   * Suppress the built-in command-palette search field. The Inventory screen sets this — it
   * carries its own search box and toolbar, so the shared header search would be redundant.
   */
  readonly hideSearch?: boolean;
  /** Where the brand "home" link points. Defaults to the dashboard (`/`). */
  readonly homeTo?: string;
  /** Extra classes merged onto the `<header>` (e.g. bottom padding for sticky layouts). */
  readonly className?: string;
}

/**
 * Foundry PageHeader — the one canonical screen header (spec §2.4.1 / §2.4.2).
 *
 * Every top-level screen (bar the Dashboard "home hero") composes its header from
 * this primitive so the brand home-link, the icon + `<h1>` title, the page actions and
 * the global navigation all share one fixed size, spacing and position. It always
 * renders the {@link AppNav} menu, so every screen can reach every other — the headers
 * used to each hand-list a different subset of links, leaving some screens unreachable.
 * Pass `icon`, `title` and optional page-specific `actions`; the layout is owned here.
 */
export function PageHeader({ icon, title, actions, hideSearch, homeTo = '/', className }: PageHeaderProps) {
  return (
    <header className={cn('flex flex-wrap items-center gap-3', className)}>
      <Link to={homeTo} className="flex items-center gap-2 text-foreground [&_svg]:size-6">
        <BrandMark className="size-9 rounded-xl" />
        <span className="text-lg font-semibold tracking-tight">Gubbins</span>
      </Link>
      <h1 className="flex items-center gap-2 text-lg font-semibold tracking-tight [&_svg]:size-5">
        {icon}
        {title}
      </h1>
      {/* Full-width command-palette launcher, filling the gap between the title and the
          right-aligned action row (which is the space each page reserves for its own
          buttons). Omitted where the screen has its own search (Inventory). */}
      {!hideSearch && <HeaderSearch className="min-w-[12rem] flex-1" />}
      <div className="ml-auto flex flex-wrap items-center gap-2">
        {actions}
        <AppNav />
      </div>
    </header>
  );
}
