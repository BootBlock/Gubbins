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
 * router-navigate dependency. Add item is a **split button**: its primary half adds an
 * item, and the attached chevron opens a menu whose `Import…` row navigates to Inventory
 * with the `import` intent (opening the Import dialog on arrival) — reusing the very same
 * Link+intent pattern via {@link MenuLink}'s `onSelect`.
 */
import { Link } from '@tanstack/react-router';
import { cn } from '@/lib/utils';
import { buttonVariants, Menu, MenuLink } from '@/components/foundry';
import { AddIcon, ScanIcon, ChevronDownIcon, ImportIcon } from '@/components/icons';
import { usePreferencesStore } from '@/state/stores/usePreferencesStore';
import { useInventoryEntry } from '@/features/inventory/useInventoryEntry';
import { useFeature } from '@/features/modules/useFeature';
import { HeaderSearch } from '@/features/command-palette/HeaderSearch';

export function DashboardActions() {
  const showSearch = usePreferencesStore((s) => s.dashboardCommandPalette);
  const showQuickActions = usePreferencesStore((s) => s.dashboardQuickActions);
  // The Scan quick action opens live camera scanning — the `scanner` capability
  // (modular-ui-plan §4, Phase 6). Hidden when Scanner is off; Add item always stays.
  const scannerEnabled = useFeature('scanner');
  if (!showSearch && !showQuickActions) return null;

  return (
    <div className="flex flex-wrap items-center gap-2">
      {/* The same header-search launcher used on every other screen, kept compact on the
          hero. `HeaderSearch` self-gates on the `dashboardCommandPalette` preference. */}
      <HeaderSearch className="max-w-sm" />

      {showQuickActions ? (
        <>
          {/* Split button: the primary half adds an item; the attached chevron opens a
              menu of related create actions (currently Import…). Both halves share one
              rounded pill — the primary rounds only its left edge, the trigger only its
              right, joined by a subtle divider in the primary's own foreground token. */}
          <div className="inline-flex items-stretch">
            <Link
              to="/inventory"
              onClick={() => useInventoryEntry.getState().requestIntent('add')}
              className={cn(buttonVariants({ variant: 'primary' }), 'rounded-r-none')}
              data-testid="dashboard-add-item"
            >
              <AddIcon />
              Add item
            </Link>
            <Menu
              label="More add-item actions"
              triggerVariant="primary"
              triggerClassName="rounded-l-none border-l border-primary-foreground/25 px-2 shadow-lg shadow-primary/20"
              trigger={<ChevronDownIcon />}
              triggerProps={{ 'data-testid': 'dashboard-add-menu' }}
            >
              <MenuLink
                to="/inventory"
                icon={<ImportIcon />}
                onSelect={() => useInventoryEntry.getState().requestIntent('import')}
                data-testid="dashboard-import"
              >
                Import…
              </MenuLink>
            </Menu>
          </div>
          {scannerEnabled ? (
            <Link
              to="/inventory"
              onClick={() => useInventoryEntry.getState().requestIntent('scan')}
              className={cn(buttonVariants({ variant: 'outline' }))}
              data-testid="dashboard-scan"
            >
              <ScanIcon />
              Scan
            </Link>
          ) : null}
        </>
      ) : null}
    </div>
  );
}
