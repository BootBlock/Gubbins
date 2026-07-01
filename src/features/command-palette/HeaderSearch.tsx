/**
 * HeaderSearch — the command-palette launcher shown as a search field.
 *
 * A full-width button styled to look like a search box. It doesn't search inline; clicking it
 * (or the global Ctrl/⌘-/ shortcut) opens the {@link CommandPalette} modal, where typing and
 * results live. Rendered by {@link PageHeader} on every screen (bar Inventory, which has its
 * own search) and reused on the dashboard hero, so the same entry point sits on all pages.
 *
 * Gated by the `dashboardCommandPalette` preference — the same flag that binds the modal's
 * keyboard shortcut — so switching the feature off removes both together. Deliberately
 * router-free: it only touches the two zustand stores, so screens can mount it in tests
 * without a router context.
 */
import { SearchIcon } from '@/components/icons';
import { cn } from '@/lib/utils';
import { usePreferencesStore } from '@/state/stores/usePreferencesStore';
import { useCommandPaletteStore } from './useCommandPaletteStore';

export interface HeaderSearchProps {
  /** Extra classes merged onto the trigger (e.g. `flex-1` in the header, `max-w-sm` on the hero). */
  readonly className?: string;
}

export function HeaderSearch({ className }: HeaderSearchProps) {
  const enabled = usePreferencesStore((s) => s.dashboardCommandPalette);
  if (!enabled) return null;

  return (
    <button
      type="button"
      onClick={() => useCommandPaletteStore.getState().setOpen(true)}
      data-testid="dashboard-search-trigger"
      className={cn(
        'flex h-10 w-full items-center gap-2 rounded-lg border border-border bg-input/40 px-3 text-sm text-muted-foreground transition-colors hover:bg-input/60 hover:text-foreground focus-visible:border-ring focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/40 [&_svg]:size-4',
        className,
      )}
    >
      <SearchIcon aria-hidden />
      <span>Search items…</span>
      <kbd className="ml-auto rounded border border-border bg-card px-1.5 py-0.5 font-mono text-[10px] font-medium text-muted-foreground">
        Ctrl /
      </kbd>
    </button>
  );
}
