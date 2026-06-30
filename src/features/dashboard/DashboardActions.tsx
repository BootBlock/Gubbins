/**
 * DashboardActions — the landing-page hero toolbar (improvements #1 + #2).
 *
 * Two independently-toggleable affordances:
 * - a **Search** trigger that opens the global command palette (and advertises Ctrl/⌘ K);
 * - **Quick actions** (Add item / Scan) for the most common create tasks.
 *
 * The Add/Scan buttons are `Link`s with an onClick that records a one-shot intent
 * ({@link useInventoryEntry}); the Inventory screen consumes it and opens the matching
 * dialog. Using `Link` (not an imperative navigate) keeps this renderable without a
 * router-navigate dependency.
 */
import { Link } from '@tanstack/react-router';
import { cn } from '@/lib/utils';
import { buttonVariants } from '@/components/foundry';
import { SearchIcon, AddIcon, ScanIcon } from '@/components/icons';
import { usePreferencesStore } from '@/state/stores/usePreferencesStore';
import { useInventoryEntry } from '@/features/inventory/useInventoryEntry';
import { useCommandPaletteStore } from '@/features/command-palette/useCommandPaletteStore';

export function DashboardActions() {
  const showSearch = usePreferencesStore((s) => s.dashboardCommandPalette);
  const showQuickActions = usePreferencesStore((s) => s.dashboardQuickActions);
  if (!showSearch && !showQuickActions) return null;

  return (
    <div className="flex flex-wrap items-center gap-2">
      {showSearch ? (
        <button
          type="button"
          onClick={() => useCommandPaletteStore.getState().setOpen(true)}
          data-testid="dashboard-search-trigger"
          className="flex h-10 w-full max-w-sm items-center gap-2 rounded-lg border border-border bg-input/40 px-3 text-sm text-muted-foreground transition-colors hover:bg-input/60 hover:text-foreground focus-visible:border-ring focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/40 [&_svg]:size-4"
        >
          <SearchIcon aria-hidden />
          <span>Search items…</span>
          <kbd className="ml-auto rounded border border-border bg-card px-1.5 py-0.5 font-mono text-[10px] font-medium text-muted-foreground">
            Ctrl K
          </kbd>
        </button>
      ) : null}

      {showQuickActions ? (
        <>
          <Link
            to="/inventory"
            onClick={() => useInventoryEntry.getState().requestIntent('add')}
            className={cn(buttonVariants({ variant: 'primary' }))}
            data-testid="dashboard-add-item"
          >
            <AddIcon />
            Add item
          </Link>
          <Link
            to="/inventory"
            onClick={() => useInventoryEntry.getState().requestIntent('scan')}
            className={cn(buttonVariants({ variant: 'outline' }))}
            data-testid="dashboard-scan"
          >
            <ScanIcon />
            Scan
          </Link>
        </>
      ) : null}
    </div>
  );
}
