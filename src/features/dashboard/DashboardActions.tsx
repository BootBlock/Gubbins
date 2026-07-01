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
import { AddIcon, ScanIcon } from '@/components/icons';
import { usePreferencesStore } from '@/state/stores/usePreferencesStore';
import { useInventoryEntry } from '@/features/inventory/useInventoryEntry';
import { HeaderSearch } from '@/features/command-palette/HeaderSearch';

export function DashboardActions() {
  const showSearch = usePreferencesStore((s) => s.dashboardCommandPalette);
  const showQuickActions = usePreferencesStore((s) => s.dashboardQuickActions);
  if (!showSearch && !showQuickActions) return null;

  return (
    <div className="flex flex-wrap items-center gap-2">
      {/* The same header-search launcher used on every other screen, kept compact on the
          hero. `HeaderSearch` self-gates on the `dashboardCommandPalette` preference. */}
      <HeaderSearch className="max-w-sm" />

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
