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
 *
 * Returns its controls as a Fragment (no wrapping element) rather than its own nested flex
 * row: {@link DashboardScreen} renders this alongside the global nav menu in one shared
 * `flex flex-wrap` row, so Search/Add/Scan/Menu wrap together as a single cohesive set
 * instead of each half independently deciding when to break onto a new line.
 */
import { Link } from '@tanstack/react-router';
import { cn } from '@/lib/utils';
import { buttonVariants, MenuLink, SplitButton } from '@/components/foundry';
import { AddIcon, ScanIcon, ImportIcon } from '@/components/icons';
import { usePreferencesStore } from '@/state/stores/usePreferencesStore';
import { useInventoryEntry } from '@/features/inventory/useInventoryEntry';
import { useFeature } from '@/features/modules/useFeature';
import { useT } from '@/features/i18n';
import { HeaderSearch } from '@/features/command-palette/HeaderSearch';

export function DashboardActions() {
  const t = useT();
  const showSearch = usePreferencesStore((s) => s.dashboardCommandPalette);
  const showQuickActions = usePreferencesStore((s) => s.dashboardQuickActions);
  // The Scan quick action opens live camera scanning — the `scanner` capability
  // (modular-ui-plan §4, Phase 6). Hidden when Scanner is off; Add item always stays.
  const scannerEnabled = useFeature('scanner');
  if (!showSearch && !showQuickActions) return null;

  return (
    <>
      {/* The same header-search launcher used on every other screen, kept compact on the
          hero. `HeaderSearch` self-gates on the `dashboardCommandPalette` preference.
          `flex-1` (capped at `max-w-sm`, floored at a usable `min-w`) mirrors PageHeader's
          own search sizing: HeaderSearch's base class is `w-full`, so without an explicit
          flex-basis here it resolves its used flex-basis to that 100% width and claims the
          entire row for itself before the max-width cap is even applied — forcing Add
          item/Scan/Menu onto a new line regardless of how much space is actually free.
          `flex-1` gives it a `0%` basis instead, so it *grows* to fill available space
          alongside its siblings rather than forcing them off the line. */}
      <HeaderSearch className="min-w-[10rem] max-w-sm flex-1" />

      {showQuickActions ? (
        <>
          {/* Split button: the primary half adds an item; the attached chevron opens a
              menu of related create actions (currently Import…). Both halves are `Link`s
              on the shared Foundry primitive, keeping the add/scan intent pattern. */}
          <SplitButton
            menuLabel={t('dashboard.actions.moreAddItem')}
            triggerProps={{ 'data-testid': 'dashboard-add-menu' }}
            primary={
              <Link
                to="/inventory"
                onClick={() => useInventoryEntry.getState().requestIntent('add')}
                className={cn(buttonVariants({ variant: 'primary' }))}
                data-testid="dashboard-add-item"
              >
                <AddIcon />
                {t('dashboard.actions.addItem')}
              </Link>
            }
          >
            <MenuLink
              to="/inventory"
              icon={<ImportIcon />}
              onSelect={() => useInventoryEntry.getState().requestIntent('import')}
              data-testid="dashboard-import"
            >
              {t('dashboard.actions.import')}
            </MenuLink>
          </SplitButton>
          {scannerEnabled ? (
            <Link
              to="/inventory"
              onClick={() => useInventoryEntry.getState().requestIntent('scan')}
              className={cn(buttonVariants({ variant: 'outline' }))}
              data-testid="dashboard-scan"
            >
              <ScanIcon />
              {t('dashboard.actions.scan')}
            </Link>
          ) : null}
        </>
      ) : null}
    </>
  );
}
